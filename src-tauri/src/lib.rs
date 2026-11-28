//! Cerebra's desktop shell: one window running the UI in `ui/`, which talks to the engine
//! through `dispatch` (the same contract as the browser preview), plus a few desktop-only
//! commands (open/create a library, download models) and the `cerebrafile://` protocol for
//! showing library files (images, PDFs) inside notes.

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cerebra_core::api::mime_for;
use cerebra_core::parse::percent_decode;
use cerebra_core::session::Session;
use serde_json::{Value, json};
use tauri::http::{Request, Response, StatusCode};
use tauri::{AppHandle, Emitter, Manager, State};

mod connector;
mod keychain;
mod models;
mod runner;
mod sidecar;
mod sources;
mod state;
mod watch;

use keychain::Keychain;
use runner::{Runner, Settings};
use sources::{SourceInput, Sources};
use state::AppSettings;

#[derive(Default)]
struct AppState {
    session: Arc<Mutex<Option<Session>>>,
    watcher: Mutex<Option<notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>>>,
    downloading: Mutex<bool>,
    /// Set by the file watcher; the runner turns it into an auto-connect check.
    changed: Arc<AtomicBool>,
    /// Set when a library is opened; the runner takes a fresh snapshot.
    reopened: Arc<AtomicBool>,
    /// Latest status per AI source from the agents (resting, key problem…).
    statuses: Arc<Mutex<serde_json::Map<String, Value>>>,
    sources_lock: Mutex<()>,
}

fn sources_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("sources.json"))
}

fn agents_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("agents.json"))
}

/// How to start the agents: `CEREBRA_AGENTS`, else the bundled `cerebra-agents` next to the
/// app, else (development) `uv run` in the repository's `agents/` folder.
fn agents_command() -> Vec<String> {
    if let Ok(c) = std::env::var("CEREBRA_AGENTS") {
        return c.split_whitespace().map(String::from).collect();
    }
    if let Ok(exe) = std::env::current_exe() {
        let name = if cfg!(windows) {
            "cerebra-agents.exe"
        } else {
            "cerebra-agents"
        };
        let bundled = exe.with_file_name(name);
        if bundled.is_file() {
            return vec![bundled.to_string_lossy().into_owned()];
        }
    }
    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("../agents");
    vec![
        "uv".into(),
        "run".into(),
        "--quiet".into(),
        "--directory".into(),
        dev.to_string_lossy().into_owned(),
        "cerebra-agents".into(),
    ]
}

/// The agents' tools: this same program in MCP mode (the library path is appended).
fn mcp_command() -> Vec<String> {
    let exe = app_exe().to_string_lossy().into_owned();
    vec![exe, "mcp".into(), "--agent".into(), "--library".into()]
}

/// The program path other apps should start. Inside a Linux AppImage the running binary lives in a
/// temporary mount that disappears on exit, so the AppImage file itself is used instead.
fn stable_exe(appimage: Option<String>, current: PathBuf) -> PathBuf {
    match appimage.filter(|a| !a.is_empty()) {
        Some(a) => PathBuf::from(a),
        None => current,
    }
}

/// The Microsoft Store version runs from `C:\Program Files\WindowsApps\…`, which other apps may not
/// start programs from. Its package registers the execution alias `cerebra.exe`
/// (`packaging/msix/AppxManifest.xml`), which Windows places in `%LOCALAPPDATA%\Microsoft\WindowsApps`.
fn store_alias(current: &Path, local_appdata: Option<String>) -> Option<PathBuf> {
    let path = current.to_string_lossy().to_ascii_lowercase().replace('/', "\\");
    let packaged = path.contains("\\windowsapps\\");
    let base = local_appdata.filter(|d| !d.is_empty())?;
    packaged.then(|| {
        // Built by hand so the result is a Windows path on every OS (the tests run on Linux too).
        PathBuf::from(format!(
            "{}\\Microsoft\\WindowsApps\\cerebra.exe",
            base.trim_end_matches(['\\', '/'])
        ))
    })
}

/// Running as the Microsoft Store (MSIX) version.
fn is_store_install() -> bool {
    cfg!(windows)
        && std::env::current_exe()
            .ok()
            .and_then(|c| store_alias(&c, std::env::var("LOCALAPPDATA").ok()))
            .is_some()
}

const MANUAL_SETUP: &str = "In the Microsoft Store version, Claude Desktop is set up by hand: copy the setup text in Cerebra and paste it into Claude Desktop (Settings, Developer, Edit Config)";

fn app_exe() -> PathBuf {
    let current = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("cerebra"));
    if cfg!(windows)
        && let Some(alias) = store_alias(&current, std::env::var("LOCALAPPDATA").ok())
    {
        return alias;
    }
    stable_exe(std::env::var("APPIMAGE").ok(), current)
}

/// Library files that may be opened in another app: documents and pictures only, never programs
/// or scripts (an imported vault could contain anything).
fn openable(path: &str) -> bool {
    let ext = path
        .rsplit_once('.')
        .map(|x| x.1.to_ascii_lowercase())
        .unwrap_or_default();
    [
        "pdf", "docx", "pptx", "txt", "md", "png", "jpg", "jpeg", "webp", "gif",
    ]
    .contains(&ext.as_str())
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn settings_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("app.json"))
}

/// Where the models live: `CEREBRA_MODELS`, else `<repo>/models` in development builds when
/// present, else `<app data>/models`.
fn models_dir(app: &AppHandle) -> PathBuf {
    if let Ok(d) = std::env::var("CEREBRA_MODELS") {
        return PathBuf::from(d);
    }
    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("../models");
    if cfg!(debug_assertions) && dev.join("embed").is_dir() {
        return dev;
    }
    data_dir(app).map(|d| d.join("models")).unwrap_or(dev)
}

fn models_status(app: &AppHandle) -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        return "unavailable";
    }
    if *app
        .state::<AppState>()
        .downloading
        .lock()
        .unwrap_or_else(|e| e.into_inner())
    {
        return "downloading";
    }
    match models::status(&models_dir(app), models::FILES) {
        models::Status::Ready => "ready",
        models::Status::Missing => "missing",
    }
}

/// Make `session` the open library: remember it, and watch it for changes.
fn install(app: &AppHandle, mut session: Session) -> Result<Value, String> {
    let root = session.root().to_path_buf();
    let mut settings = AppSettings::load(&settings_file(app)?);
    settings.remember(&root.to_string_lossy());
    settings.save(&settings_file(app)?)?;
    let info = session.dispatch("library_info", json!({}))?;

    let state = app.state::<AppState>();
    *state.session.lock().map_err(|_| "internal lock error")? = Some(session);
    let handle = app.clone();
    let watcher = watch::start(&root, move || {
        let state = handle.state::<AppState>();
        let reloaded = state
            .session
            .lock()
            .ok()
            .and_then(|mut o| o.as_mut().map(|s| s.reload().is_ok()));
        if reloaded == Some(true) {
            state.changed.store(true, Ordering::SeqCst);
            let _ = handle.emit("library-changed", ());
        }
    })
    .ok();
    *state.watcher.lock().map_err(|_| "internal lock error")? = watcher;
    state.reopened.store(true, Ordering::SeqCst);
    Ok(info)
}

#[tauri::command(async)]
fn dispatch(cmd: String, args: Value, state: State<AppState>) -> Result<Value, String> {
    let mut open = state
        .session
        .lock()
        .map_err(|_| "internal lock error".to_string())?;
    match open.as_mut() {
        Some(s) => s.dispatch(&cmd, args),
        None => Err("Open or create a library first".into()),
    }
}

#[tauri::command]
fn app_state(app: AppHandle, state: State<AppState>) -> Result<Value, String> {
    let settings = AppSettings::load(&settings_file(&app)?);
    let library = state
        .session
        .lock()
        .map_err(|_| "internal lock error")?
        .as_ref()
        .map(|s| s.root().to_string_lossy().into_owned());
    Ok(json!({
        "library": library,
        "recent": settings.recent,
        "models": models_status(&app),
        "preview": false,
    }))
}

#[tauri::command(async)]
fn open_library(path: String, app: AppHandle) -> Result<Value, String> {
    install(&app, Session::open(Path::new(&path))?)
}

#[tauri::command(async)]
fn create_library(path: String, app: AppHandle) -> Result<Value, String> {
    install(&app, Session::create(Path::new(&path))?)
}

/// Download the models in the background; `models-progress {done,total}` events, then
/// `models-ready` (the app restarts to load them) or `models-error`.
#[tauri::command]
fn download_models(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    {
        let mut busy = state.downloading.lock().map_err(|_| "internal lock error")?;
        if *busy {
            return Ok(());
        }
        *busy = true;
    }
    let dir = models_dir(&app);
    std::thread::spawn(move || {
        let progress = |done, total| {
            let _ = app.emit("models-progress", json!({ "done": done, "total": total }));
        };
        let result = models::download(&dir, models::FILES, progress);
        *app.state::<AppState>()
            .downloading
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = false;
        match result {
            Ok(()) => {
                let _ = app.emit("models-ready", ());
            }
            Err(e) => {
                let _ = app.emit("models-error", e);
            }
        }
    });
    Ok(())
}

#[tauri::command]
fn restart(app: AppHandle) {
    app.restart();
}

#[tauri::command]
fn sources_list(app: AppHandle, state: State<AppState>) -> Result<Value, String> {
    let list = Sources::load(&sources_file(&app)?).list;
    let usage = state
        .session
        .lock()
        .map_err(|_| "internal lock error")?
        .as_ref()
        .and_then(|s| s.jobs().usage_today().ok())
        .unwrap_or_default();
    let statuses = state.statuses.lock().map_err(|_| "internal lock error")?.clone();
    Ok(json!({ "sources": list, "presets": sources::PRESETS, "usage": usage, "statuses": statuses }))
}

fn edit_sources<R>(
    app: &AppHandle,
    f: impl FnOnce(&mut Sources, &mut Keychain) -> Result<R, String>,
) -> Result<R, String> {
    let state = app.state::<AppState>();
    let _guard = state.sources_lock.lock().map_err(|_| "internal lock error")?;
    let file = sources_file(app)?;
    let mut s = Sources::load(&file);
    let r = f(&mut s, &mut Keychain)?;
    s.save(&file)?;
    Ok(r)
}

#[tauri::command]
fn source_add(input: SourceInput, api_key: Option<String>, app: AppHandle) -> Result<Value, String> {
    edit_sources(&app, |s, k| s.add(input, api_key.as_deref(), k)).map(|x| json!(x))
}

#[tauri::command]
fn source_update(
    id: String,
    input: SourceInput,
    api_key: Option<String>,
    app: AppHandle,
) -> Result<Value, String> {
    edit_sources(&app, |s, k| s.update(&id, input, api_key.as_deref(), k)).map(|x| json!(x))
}

#[tauri::command]
fn source_remove(id: String, app: AppHandle) -> Result<(), String> {
    edit_sources(&app, |s, k| s.remove(&id, k))
}

#[tauri::command]
fn source_reorder(ids: Vec<String>, app: AppHandle) -> Result<(), String> {
    edit_sources(&app, |s, _| s.reorder(&ids))
}

/// Try one source with a tiny request (through a short-lived agents process).
#[tauri::command(async)]
fn source_test(id: String, app: AppHandle) -> Result<Value, String> {
    let list = Sources::load(&sources_file(&app)?);
    let all = list.payload(&Keychain, &[]);
    let mut source = all
        .into_iter()
        .find(|s| s["id"] == id.as_str())
        .ok_or("Turn the source on to test it")?;
    source["caps"] = json!({});
    let session = Arc::new(Mutex::new(None));
    let mut r = Runner::new(session, agents_command(), mcp_command(), Box::new(|_, _| {}));
    r.test_source(source)
}

/// Local model apps that are running now (Ollama, LM Studio) and their models.
#[tauri::command(async)]
fn detect_local_models() -> Value {
    let get = |url: &str| -> Option<Value> {
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_millis(800)))
            .build()
            .new_agent();
        agent.get(url).call().ok()?.body_mut().read_json::<Value>().ok()
    };
    let ollama: Vec<Value> = get("http://localhost:11434/api/tags")
        .and_then(|v| v["models"].as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|m| m["name"].as_str().map(|n| json!(n)))
        .collect();
    let lmstudio: Vec<Value> = get("http://localhost:1234/v1/models")
        .and_then(|v| v["data"].as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|m| m["id"].as_str().map(|n| json!(n)))
        .collect();
    json!({ "ollama": ollama, "lmstudio": lmstudio })
}

#[tauri::command]
fn agents_settings_get(app: AppHandle) -> Result<Settings, String> {
    Ok(Settings::load(&agents_file(&app)?))
}

#[tauri::command]
fn agents_settings_set(settings: Settings, app: AppHandle) -> Result<Settings, String> {
    if !["strict", "balanced", "generous"].contains(&settings.threshold.as_str()) {
        return Err("Choose strict, balanced or generous".into());
    }
    let mut s = settings;
    s.budget = s.budget.clamp(5, 200);
    s.auto_delay_secs = s.auto_delay_secs.clamp(5, 3600);
    s.save(&agents_file(&app)?)?;
    let _ = app.emit("agents-settings", json!(s));
    Ok(s)
}

/// The interface zoom (text size), remembered between runs.
#[tauri::command]
fn get_zoom(app: AppHandle) -> Result<f64, String> {
    Ok(AppSettings::load(&settings_file(&app)?).zoom())
}

#[tauri::command]
fn set_zoom(zoom: f64, app: AppHandle) -> Result<f64, String> {
    let file = settings_file(&app)?;
    let mut s = AppSettings::load(&file);
    s.set_zoom(zoom);
    s.save(&file)?;
    if let Some(w) = app.get_webview_window("main") {
        w.set_zoom(s.zoom()).map_err(|e| e.to_string())?;
    }
    Ok(s.zoom())
}

/// Which AI apps have Cerebra's connector set up.
#[tauri::command]
fn connector_status() -> Result<Value, String> {
    let p = connector::Paths::system().ok_or("Couldn't find your home folder")?;
    let exe = app_exe().to_string_lossy().into_owned();
    let store = is_store_install();
    let mut m = serde_json::Map::new();
    for app in connector::AiApp::ALL {
        m.insert(
            app.id().into(),
            json!({
                "connected": connector::status(app, &p),
                "config": connector::target_file(app, &p),
                "command": exe,
                "manual": connector::manual_setup(app, store),
            }),
        );
    }
    Ok(Value::Object(m))
}

#[tauri::command]
fn connector_connect(app: String) -> Result<(), String> {
    let a = connector::AiApp::parse(&app).ok_or("Unknown app")?;
    if connector::manual_setup(a, is_store_install()) {
        return Err(MANUAL_SETUP.into());
    }
    let p = connector::Paths::system().ok_or("Couldn't find your home folder")?;
    connector::connect(a, &p, &app_exe().to_string_lossy())
}

#[tauri::command]
fn connector_disconnect(app: String) -> Result<(), String> {
    let a = connector::AiApp::parse(&app).ok_or("Unknown app")?;
    if connector::manual_setup(a, is_store_install()) {
        return Err("In the Microsoft Store version, remove Cerebra from Claude Desktop by hand: delete the \"cerebra\" entry in Claude Desktop (Settings, Developer, Edit Config)".into());
    }
    let p = connector::Paths::system().ok_or("Couldn't find your home folder")?;
    connector::disconnect(a, &p)
}

/// Open one of the library's files (e.g. an uploaded PDF) in the system's default app.
#[tauri::command]
fn open_library_file(path: String, app: AppHandle, state: State<AppState>) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if !openable(&path) {
        return Err("Cerebra only opens documents and pictures from your library, not programs".into());
    }
    let full = {
        let open = state.session.lock().map_err(|_| "internal lock error")?;
        let s = open.as_ref().ok_or("No library is open")?;
        // Only real files of the library (same check as the file protocol).
        s.read_file(&path).ok_or("File not found in this library")?;
        s.root().join(&path)
    };
    app.opener()
        .open_path(full.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Upload files dropped on the window (the desktop gives their paths, not their contents).
#[tauri::command(async)]
fn upload_paths(collection: String, paths: Vec<String>, state: State<AppState>) -> Result<Value, String> {
    let mut open = state.session.lock().map_err(|_| "internal lock error")?;
    let s = open.as_mut().ok_or("No library is open")?;
    let mut results = Vec::new();
    for p in &paths {
        let path = Path::new(p);
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        let r = if !path.is_file() {
            Err(format!("{name} isn't a file"))
        } else if size as usize > cerebra_core::upload::MAX_UPLOAD_BYTES {
            Err(format!("{name} is larger than 25 MB"))
        } else {
            std::fs::read(path)
                .map_err(|e| format!("Couldn't read {name}: {e}"))
                .and_then(|bytes| {
                    cerebra_core::upload::save_upload(s.root(), &collection, &name, &bytes)
                        .map_err(|e| e.to_string())
                })
        };
        results.push(match r {
            Ok(u) => json!({ "name": name, "note_path": u.note_path, "attachment_path": u.attachment_path }),
            Err(e) => json!({ "name": name, "error": e }),
        });
    }
    s.reload()?;
    for r in results.iter_mut() {
        if let Some(p) = r["note_path"].as_str() {
            r["note_id"] = json!(s.workspace().vault.note_by_path(p).map(|n| n.id.clone()));
        }
    }
    Ok(Value::Array(results))
}

/// A `.cerebra` file Cerebra was opened with (double-click / "Open with"), if any.
#[tauri::command]
fn opened_file() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|a| a.to_lowercase().ends_with(".cerebra") && Path::new(a).is_file())
}

/// The background loop that runs agent jobs.
fn start_runner(app: AppHandle) {
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let emit_app = app.clone();
        let statuses = state.statuses.clone();
        let mut runner = Runner::new(
            state.session.clone(),
            agents_command(),
            mcp_command(),
            Box::new(move |name: &str, v: Value| {
                if name == "source-status"
                    && let Some(id) = v["source_id"].as_str()
                    && let Ok(mut m) = statuses.lock()
                {
                    m.insert(id.to_string(), v.clone());
                }
                // A retired model was replaced by the agents: keep the new one for next time.
                if name == "source-status"
                    && let (Some(id), Some(model)) = (v["source_id"].as_str(), v["model"].as_str())
                {
                    let _ = edit_sources(&emit_app, |s, _| Ok(s.set_model(id, model)));
                    let _ = emit_app.emit("sources-changed", ());
                }
                let _ = emit_app.emit(name, v);
            }),
        );
        runner.log = data_dir(&app).ok().map(|d| d.join("agents.log"));
        loop {
            std::thread::sleep(Duration::from_millis(1500));
            if state.reopened.swap(false, Ordering::SeqCst) {
                runner.snapshot();
            }
            if state.changed.swap(false, Ordering::SeqCst) {
                runner.library_changed();
            }
            let Ok(file) = agents_file(&app) else { continue };
            let settings = Settings::load(&file);
            if runner.auto_enqueue(&settings) > 0 {
                let _ = app.emit("jobs-changed", ());
            }
            // Read keys from the keychain only when there is work to do.
            let queued = runner
                .with_session(|s| s.jobs().has_queued().unwrap_or(false))
                .unwrap_or(false);
            if !queued {
                continue;
            }
            let (sources, local) = match sources_file(&app) {
                Ok(f) => {
                    let usage = runner
                        .with_session(|s| s.jobs().usage_today().unwrap_or_default())
                        .unwrap_or_default();
                    let list = Sources::load(&f);
                    (
                        list.payload(&Keychain, &usage),
                        list.payload_local_only(&Keychain, &usage),
                    )
                }
                Err(_) => continue,
            };
            if let Err(e) = runner.tick(&sources, &local, &settings) {
                let _ = app.emit("agents-error", e);
            }
        }
    });
}

fn serve_file(app: &AppHandle, request: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let not_found = || {
        Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Cow::Borrowed(&b""[..]))
            .unwrap()
    };
    let rel = percent_decode(request.uri().path().trim_start_matches('/'));
    let state = app.state::<AppState>();
    let Ok(open) = state.session.lock() else {
        return not_found();
    };
    let Some(bytes) = open.as_ref().and_then(|s| s.read_file(&rel)) else {
        return not_found();
    };
    Response::builder()
        .header("Content-Type", mime_for(&rel))
        .header("X-Content-Type-Options", "nosniff")
        .body(Cow::Owned(bytes))
        .unwrap()
}

/// `Cerebra mcp [--agent] [--library <path>]`: the MCP server for AI apps and the agents. Without
/// `--library` it serves the library last opened in the app.
pub fn run_mcp(args: &[String]) -> Result<(), String> {
    let agent = args.iter().any(|a| a == "--agent");
    let library = match args.iter().position(|a| a == "--library") {
        Some(i) => args.get(i + 1).cloned().ok_or("--library needs a path")?,
        None => {
            let file = dirs::data_dir()
                .ok_or("no app data folder")?
                .join("app.cerebra.desktop")
                .join("app.json");
            AppSettings::load(&file)
                .library
                .ok_or("Open a library in Cerebra first")?
        }
    };
    let models = std::env::var("CEREBRA_MODELS")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::data_dir()
                .unwrap_or_default()
                .join("app.cerebra.desktop")
                .join("models")
        });
    cerebra_core::semantic::set_models_dir(models.clone());
    cerebra_core::ocr::set_models_dir(models);
    let excluded: Vec<String> = args
        .windows(2)
        .filter(|w| w[0] == "--exclude")
        .map(|w| w[1].clone())
        .collect();
    let mut server = cerebra_core::mcp::Server::open(Path::new(&library), agent)?.excluding(excluded);
    let stdin = std::io::stdin();
    cerebra_core::mcp::serve(&mut server, stdin.lock(), std::io::stdout()).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            let dir = models_dir(&handle);
            cerebra_core::semantic::set_models_dir(dir.clone());
            cerebra_core::ocr::set_models_dir(dir);
            // Reopen the last library, if it still exists.
            if let Ok(file) = settings_file(&handle)
                && let Some(last) = AppSettings::load(&file).library
                && let Ok(session) = Session::open(Path::new(&last))
            {
                let _ = install(&handle, session);
            }
            if let (Ok(file), Some(w)) = (settings_file(&handle), handle.get_webview_window("main")) {
                let _ = w.set_zoom(AppSettings::load(&file).zoom());
            }
            start_runner(handle);
            Ok(())
        })
        .register_uri_scheme_protocol("cerebrafile", |ctx, request| {
            serve_file(ctx.app_handle(), &request)
        })
        .invoke_handler(tauri::generate_handler![
            dispatch,
            app_state,
            open_library,
            create_library,
            download_models,
            restart,
            sources_list,
            source_add,
            source_update,
            source_remove,
            source_reorder,
            source_test,
            detect_local_models,
            agents_settings_get,
            agents_settings_set,
            connector_status,
            connector_connect,
            connector_disconnect,
            opened_file,
            open_library_file,
            upload_paths,
            get_zoom,
            set_zoom
        ])
        .run(tauri::generate_context!())
        .expect("error while running Cerebra");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appimage_path_wins_over_the_temporary_mount() {
        let mount = PathBuf::from("/tmp/.mount_Cereb12/usr/bin/cerebra-app");
        assert_eq!(
            stable_exe(Some("/home/me/Apps/Cerebra.AppImage".into()), mount.clone()),
            PathBuf::from("/home/me/Apps/Cerebra.AppImage")
        );
        assert_eq!(stable_exe(None, mount.clone()), mount);
        assert_eq!(stable_exe(Some(String::new()), mount.clone()), mount);
    }

    #[test]
    fn store_install_uses_the_execution_alias() {
        let packaged =
            PathBuf::from(r"C:\Program Files\WindowsApps\KawaiiInosuke.Cerebra_0.1.0.0_x64__abc\Cerebra.exe");
        assert_eq!(
            store_alias(&packaged, Some(r"C:\Users\me\AppData\Local".into())),
            Some(PathBuf::from(
                r"C:\Users\me\AppData\Local\Microsoft\WindowsApps\cerebra.exe"
            ))
        );
        // A normal install (MSI/EXE) or a missing LOCALAPPDATA keeps the real path.
        let normal = PathBuf::from(r"C:\Program Files\Cerebra\Cerebra.exe");
        assert_eq!(
            store_alias(&normal, Some(r"C:\Users\me\AppData\Local".into())),
            None
        );
        assert_eq!(store_alias(&packaged, None), None);
    }

    #[test]
    fn only_safe_files_open_in_other_apps() {
        for ok in [
            "Biology/Files/unit3.pdf",
            "a/b.docx",
            "x.pptx",
            "p.PNG",
            "n.md",
            "t.txt",
            "i.jpeg",
            "w.webp",
            "g.gif",
        ] {
            assert!(openable(ok), "{ok}");
        }
        for bad in [
            "run.exe",
            "x.sh",
            "a.desktop",
            "b.bat",
            "c.app",
            "d.command",
            "e.js",
            "f.html",
            "g.lnk",
            "noext",
        ] {
            assert!(!openable(bad), "{bad}");
        }
    }
}
