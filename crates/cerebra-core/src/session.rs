//! One open library and the single `dispatch(cmd, args)` entry point the UI talks to.
//! The desktop app (a Tauri command) and the browser preview (`cerebra <library> serve`)
//! both forward to this, so they can never behave differently. The command list is the
//! contract in the Phase 1 plan; every value is plain JSON.

use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::ai_layer::{self, AiLayer, SaveRequest, Status};
use crate::api::{GraphRequest, Workspace, status_name};
use crate::store::Store;
use crate::upload::MAX_UPLOAD_BYTES;
use crate::vault::Vault;

/// Cerebra's own folder inside a library.
pub const DATA_DIR: &str = ".cerebra";

pub struct Session {
    root: PathBuf,
    ws: Workspace,
    jobs: crate::jobs::Jobs,
    /// Keep the search index in memory instead of `.cerebra/index.db` (for `cerebra mcp`,
    /// which runs next to the app and must not rebuild the app's index file).
    memory_index: bool,
}

/// A name usable as a collection folder or note file on every OS.
pub fn valid_name(name: &str) -> bool {
    let n = name.trim();
    if n.is_empty() || n != name || n.starts_with('.') || n.chars().count() > 120 {
        return false;
    }
    if n.chars().any(|c| {
        c.is_control()
            || matches!(
                c,
                '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '#' | '^' | '[' | ']'
            )
    }) {
        return false;
    }
    let stem = n.split('.').next().unwrap_or(n).to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit());
    !reserved && !n.ends_with('.')
}

fn args<T: for<'de> Deserialize<'de>>(v: Value) -> Result<T, String> {
    serde_json::from_value(v).map_err(|e| format!("bad arguments: {e}"))
}

fn to_json<T: serde::Serialize>(v: T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

impl Session {
    /// Open an existing library folder (creates `.cerebra/` inside it if needed).
    pub fn open(path: &Path) -> Result<Session, String> {
        Session::open_with(path, false)
    }

    /// Like [`Session::open`], optionally keeping the search index in memory.
    pub fn open_with(path: &Path, memory_index: bool) -> Result<Session, String> {
        if !path.is_dir() {
            return Err(format!("{} isn't a folder", path.display()));
        }
        let root = path.canonicalize().map_err(|e| e.to_string())?;
        let data = root.join(DATA_DIR);
        std::fs::create_dir_all(&data).map_err(|e| format!("Couldn't create {}: {e}", data.display()))?;
        let meta = data.join("library.json");
        if !meta.exists() {
            let id = crate::vault::note_id(&format!("{}{}", root.display(), crate::time::now_iso()));
            let info = json!({ "id": id, "created": crate::time::now_iso(), "version": 1 });
            std::fs::write(&meta, serde_json::to_string_pretty(&info).unwrap()).map_err(|e| e.to_string())?;
        }
        let ws = Self::load(&root, memory_index)?;
        let jobs = crate::jobs::Jobs::open(&root)?;
        if !memory_index {
            jobs.requeue_running()?;
        }
        Ok(Session {
            root,
            ws,
            jobs,
            memory_index,
        })
    }

    /// Create a new library folder (or use an existing empty one) and open it.
    pub fn create(path: &Path) -> Result<Session, String> {
        if path.exists() && !path.is_dir() {
            return Err(format!("{} is a file, not a folder", path.display()));
        }
        std::fs::create_dir_all(path).map_err(|e| format!("Couldn't create {}: {e}", path.display()))?;
        Session::open(path)
    }

    fn load(root: &Path, memory_index: bool) -> Result<Workspace, String> {
        let vault = Vault::load(root).map_err(|e| e.to_string())?;
        let store = if memory_index {
            Store::open_in_memory()
        } else {
            Store::open(root.join(DATA_DIR).join("index.db"))
        }
        .map_err(|e| format!("Couldn't open the index: {e}"))?;
        let mut ws = Workspace::with_store(vault, store).map_err(|e| e.to_string())?;
        ws.ai = AiLayer::load(root);
        Ok(ws)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn workspace(&self) -> &Workspace {
        &self.ws
    }

    /// Re-read the library from disk (after a file change or an edit).
    pub fn reload(&mut self) -> Result<(), String> {
        self.ws = Self::load(&self.root, self.memory_index)?;
        Ok(())
    }

    /// Re-read only the AI layer (cheap; another process may have saved connections).
    pub fn reload_ai(&mut self) {
        self.ws.ai = AiLayer::load(&self.root);
    }

    /// Bytes of one library file, or `None` for anything outside it (or Cerebra's own data).
    pub fn read_file(&self, rel: &str) -> Option<Vec<u8>> {
        if rel.starts_with(DATA_DIR) || rel.contains('%') {
            return None;
        }
        self.ws.read_file(rel)
    }

    pub fn jobs(&self) -> &crate::jobs::Jobs {
        &self.jobs
    }

    /// Notes whose text changed since the agents last connected them (or never were),
    /// except notes that opted out with `cerebra: { auto_connect: false }`.
    pub fn changed_notes(&self) -> Vec<String> {
        self.ws
            .vault
            .notes
            .iter()
            .filter(|n| n.meta.frontmatter.pointer("/cerebra/auto_connect") != Some(&Value::Bool(false)))
            .filter(|n| self.jobs.connected_hash(&n.path).ok().flatten().as_deref() != Some(n.hash.as_str()))
            .map(|n| n.path.clone())
            .collect()
    }

    /// Record that the note at `path` was connected at its current text.
    pub fn mark_connected(&self, path: &str) -> Result<(), String> {
        let n = self.ws.vault.note_by_path(path).ok_or("note not found")?;
        self.jobs.mark_connected(&n.path, &n.hash)
    }

    /// Passages from other notes that may relate to `idea` in `note` (not the note itself,
    /// nor notes already linked to it either way). Local search only, no AI cost.
    pub fn candidates_for(&self, note: &str, idea: &str, limit: usize) -> Result<Value, String> {
        let w = &self.ws;
        let n = w
            .vault
            .find_note(note)
            .ok_or_else(|| format!("note not found: {note}"))?;
        let mut linked: std::collections::HashSet<&str> =
            w.index.backlinks(&n.path).keys().copied().collect();
        if let Some(out) = w.index.resolved.get(&n.path) {
            linked.extend(out.keys().map(String::as_str));
        }
        let found = crate::retrieve::retrieve(&w.vault, &w.store, idea, None, limit.clamp(1, 20) * 4)
            .map_err(|e| e.to_string())?;
        let mut seen = std::collections::HashSet::new();
        let out: Vec<Value> = found
            .passages
            .into_iter()
            .filter(|p| p.path != n.path && !linked.contains(p.path.as_str()))
            .filter(|p| seen.insert((p.path.clone(), p.heading_path.clone())))
            .take(limit.clamp(1, 20))
            .map(|p| json!({ "note_id": p.note_id, "path": p.path, "title": p.title, "heading_path": p.heading_path, "text": p.text }))
            .collect();
        Ok(Value::Array(out))
    }

    fn note_id_for(&self, path: &str) -> Option<String> {
        self.ws.vault.note_by_path(path).map(|n| n.id.clone())
    }

    pub fn dispatch(&mut self, cmd: &str, a: Value) -> Result<Value, String> {
        let a = if a.is_null() { json!({}) } else { a };
        match cmd {
            "library_info" => to_json(self.ws.info()),
            "list_notes" => {
                #[derive(Deserialize)]
                struct A {
                    collection: Option<String>,
                }
                let A { collection } = args(a)?;
                let notes: Vec<_> = self
                    .ws
                    .list_notes()
                    .into_iter()
                    .filter(|n| collection.is_none() || n.collection == collection)
                    .collect();
                to_json(notes)
            }
            "get_note" => {
                #[derive(Deserialize)]
                struct A {
                    id: String,
                }
                let A { id } = args(a)?;
                to_json(self.ws.get_note(&id).map_err(|e| e.to_string())?)
            }
            "search" => {
                #[derive(Deserialize)]
                struct A {
                    query: String,
                    collection: Option<String>,
                    limit: Option<usize>,
                }
                let A {
                    query,
                    collection,
                    limit,
                } = args(a)?;
                to_json(
                    self.ws
                        .search(&query, collection.as_deref(), limit.unwrap_or(20))
                        .map_err(|e| e.to_string())?,
                )
            }
            "graph" => {
                let req: GraphRequest = args(a)?;
                to_json(self.ws.graph(&req).map_err(|e| e.to_string())?)
            }
            "context_pack" => {
                #[derive(Deserialize)]
                struct A {
                    question: String,
                    collection: Option<String>,
                }
                let A { question, collection } = args(a)?;
                let w = &self.ws;
                to_json(
                    crate::context::build_context(
                        &w.vault,
                        &w.index,
                        &w.store,
                        &question,
                        collection.as_deref(),
                        crate::context::DEFAULT_BUDGET,
                    )
                    .map_err(|e| e.to_string())?,
                )
            }
            "upload" => {
                #[derive(Deserialize)]
                struct A {
                    collection: String,
                    name: String,
                    data_base64: String,
                }
                let A {
                    collection,
                    name,
                    data_base64,
                } = args(a)?;
                if data_base64.len() / 4 * 3 > MAX_UPLOAD_BYTES + 3 {
                    return Err(format!("{name} is larger than 25 MB"));
                }
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(data_base64.trim())
                    .map_err(|_| "The file couldn't be read".to_string())?;
                let r = crate::upload::save_upload(&self.root, &collection, &name, &bytes)
                    .map_err(|e| e.to_string())?;
                self.reload()?;
                Ok(json!({
                    "note_path": r.note_path,
                    "attachment_path": r.attachment_path,
                    "note_id": self.note_id_for(&r.note_path),
                }))
            }
            "import_folder" => {
                #[derive(Deserialize)]
                struct A {
                    source: String,
                    collection: String,
                }
                let A { source, collection } = args(a)?;
                let r = crate::import::import_folder(&self.root, Path::new(&source), &collection)
                    .map_err(|e| e.to_string())?;
                self.reload()?;
                to_json(r)
            }
            "create_collection" => {
                #[derive(Deserialize)]
                struct A {
                    name: String,
                }
                let A { name } = args(a)?;
                if !valid_name(&name) || crate::vault::is_ignored_dir(&name) {
                    return Err("That name can't be used for a collection".into());
                }
                let dir = self.root.join(&name);
                if dir.exists() {
                    return Err(format!("A collection called \"{name}\" already exists"));
                }
                std::fs::create_dir(&dir).map_err(|e| e.to_string())?;
                Ok(json!({ "name": name }))
            }
            "new_note" => {
                #[derive(Deserialize)]
                struct A {
                    collection: Option<String>,
                    title: String,
                }
                let A { collection, title } = args(a)?;
                if !valid_name(&title) {
                    return Err("That title can't be used as a file name".into());
                }
                let dir = match &collection {
                    Some(c) => {
                        let d = self.root.join(c);
                        if !valid_name(c) || !d.is_dir() {
                            return Err(format!("Collection not found: {c}"));
                        }
                        d
                    }
                    None => self.root.clone(),
                };
                let path = (1..)
                    .map(|n| {
                        if n == 1 {
                            dir.join(format!("{title}.md"))
                        } else {
                            dir.join(format!("{title} ({n}).md"))
                        }
                    })
                    .find(|p| !p.exists())
                    .expect("a free name");
                std::fs::write(&path, format!("# {title}\n\n")).map_err(|e| e.to_string())?;
                self.reload()?;
                let rel = match &collection {
                    Some(c) => format!("{c}/{}", path.file_name().unwrap().to_string_lossy()),
                    None => path.file_name().unwrap().to_string_lossy().into_owned(),
                };
                Ok(json!({ "id": self.note_id_for(&rel), "path": rel }))
            }
            "save_note" => {
                #[derive(Deserialize)]
                struct A {
                    id: String,
                    text: String,
                }
                let A { id, text } = args(a)?;
                let path = self
                    .ws
                    .vault
                    .note_by_id(&id)
                    .ok_or("note not found")?
                    .path
                    .clone();
                std::fs::write(self.root.join(&path), text).map_err(|e| format!("Couldn't save: {e}"))?;
                self.reload()?;
                let id = self.note_id_for(&path).ok_or("note not found")?;
                to_json(self.ws.get_note(&id).map_err(|e| e.to_string())?)
            }
            "ai_list" => {
                #[derive(Deserialize)]
                struct A {
                    status: Option<Status>,
                    collection: Option<String>,
                    note_id: Option<String>,
                }
                let A {
                    status,
                    collection,
                    note_id,
                } = args(a)?;
                let v = &self.ws.vault;
                let note_path = note_id.and_then(|id| v.note_by_id(&id).map(|n| n.path.clone()));
                let in_collection =
                    |p: &str| collection.is_none() || crate::collection::collection_of(p) == collection;
                let connections: Vec<Value> = self
                    .ws
                    .ai
                    .connections
                    .iter()
                    .filter(|c| status.is_none_or(|s| c.status == s))
                    .filter(|c| in_collection(&c.from) || in_collection(&c.to))
                    .filter(|c| note_path.as_ref().is_none_or(|p| c.from == *p || c.to == *p))
                    .filter_map(|c| {
                        let (f, t) = (v.note_by_path(&c.from)?, v.note_by_path(&c.to)?);
                        let mut j = serde_json::to_value(c).ok()?;
                        j["status"] = json!(status_name(c.status));
                        j["from_title"] = json!(f.title);
                        j["to_title"] = json!(t.title);
                        j["from_id"] = json!(f.id);
                        j["to_id"] = json!(t.id);
                        Some(j)
                    })
                    .collect();
                let concepts: Vec<_> = self
                    .ws
                    .ai
                    .visible_concepts(v)
                    .into_iter()
                    .filter(|k| status.is_none_or(|s| k.status == s))
                    .filter(|k| collection.as_ref().is_none_or(|c| k.collection == *c))
                    .collect();
                Ok(json!({ "connections": connections, "concepts": concepts }))
            }
            "ai_set_status" => {
                #[derive(Deserialize)]
                struct A {
                    ids: Vec<String>,
                    status: Status,
                }
                let A { ids, status } = args(a)?;
                let changed = ai_layer::update(&self.root, |l| l.set_status(&ids, status))?;
                self.ws.ai = AiLayer::load(&self.root);
                Ok(json!({ "changed": changed }))
            }
            "ai_save_connections" => {
                let req: SaveRequest = args(a)?;
                let report = ai_layer::save_connections(&self.root, &self.ws.vault, req)?;
                self.ws.ai = AiLayer::load(&self.root);
                to_json(report)
            }
            "ai_promote_concept" => {
                #[derive(Deserialize)]
                struct A {
                    id: String,
                }
                let A { id } = args(a)?;
                let k = self
                    .ws
                    .ai
                    .concepts
                    .iter()
                    .find(|k| k.id == id)
                    .cloned()
                    .ok_or("concept not found")?;
                if !valid_name(&k.title) {
                    return Err("That concept's title can't be used as a file name".into());
                }
                let dir = self.root.join(&k.collection);
                let path = (1..)
                    .map(|n| {
                        if n == 1 {
                            dir.join(format!("{}.md", k.title))
                        } else {
                            dir.join(format!("{} ({n}).md", k.title))
                        }
                    })
                    .find(|p| !p.exists())
                    .expect("a free name");
                let links: Vec<String> = k
                    .notes
                    .iter()
                    .filter_map(|p| self.ws.vault.note_by_path(p))
                    .map(|n| format!("- [[{}]]", n.title))
                    .collect();
                let text = format!(
                    "# {}\n\n{}\n\n## Notes\n{}\n",
                    k.title,
                    k.summary,
                    links.join("\n")
                );
                std::fs::write(&path, text).map_err(|e| e.to_string())?;
                ai_layer::update(&self.root, |l| l.concepts.retain(|c| c.id != id))?;
                self.reload()?;
                let rel = format!("{}/{}", k.collection, path.file_name().unwrap().to_string_lossy());
                Ok(json!({ "note_path": rel, "note_id": self.note_id_for(&rel) }))
            }
            "jobs_list" => {
                #[derive(Deserialize)]
                struct A {
                    limit: Option<usize>,
                }
                let A { limit } = args(a)?;
                to_json(self.jobs.list(limit.unwrap_or(50).min(500))?)
            }
            "job_enqueue" => {
                #[derive(Deserialize)]
                struct A {
                    kind: String,
                    target: String,
                    origin: Option<String>,
                }
                let A { kind, target, origin } = args(a)?;
                let origin = origin.unwrap_or_else(|| "user".into());
                if !["user", "assistant", "auto"].contains(&origin.as_str()) {
                    return Err("bad origin".into());
                }
                Ok(json!({ "id": self.jobs.enqueue(&kind, &target, &origin)? }))
            }
            "job_cancel" => {
                #[derive(Deserialize)]
                struct A {
                    id: String,
                }
                let A { id } = args(a)?;
                self.jobs.cancel(&id)?;
                Ok(json!({}))
            }
            "usage_today" => to_json(self.jobs.usage_today()?),
            "candidates_for" => {
                #[derive(Deserialize)]
                struct A {
                    note: String,
                    idea: String,
                    limit: Option<usize>,
                }
                let A { note, idea, limit } = args(a)?;
                self.candidates_for(&note, &idea, limit.unwrap_or(6))
            }
            "share_export" => {
                #[derive(Deserialize)]
                struct A {
                    collection: String,
                    path: String,
                    include_files: Option<bool>,
                    include_suggested: Option<bool>,
                    password: Option<String>,
                }
                let A {
                    collection,
                    path,
                    include_files,
                    include_suggested,
                    password,
                } = args(a)?;
                let path = PathBuf::from(path);
                if !path.is_absolute() {
                    return Err("Choose where to save the file".into());
                }
                let opts = crate::share::ExportOptions {
                    include_files: include_files.unwrap_or(true),
                    include_suggested: include_suggested.unwrap_or(true),
                    password,
                };
                let bytes = crate::share::export_collection(&self.ws.vault, &self.ws.ai, &collection, &opts)?;
                std::fs::write(&path, &bytes).map_err(|e| format!("Couldn't save the file: {e}"))?;
                Ok(json!({ "path": path, "bytes": bytes.len() }))
            }
            "share_inspect" => {
                #[derive(Deserialize)]
                struct A {
                    path: String,
                    password: Option<String>,
                }
                let A { path, password } = args(a)?;
                let bytes = std::fs::read(&path).map_err(|e| format!("Couldn't open the file: {e}"))?;
                to_json(crate::share::inspect(&bytes, password.as_deref())?)
            }
            "share_import" => {
                #[derive(Deserialize)]
                struct A {
                    path: String,
                    password: Option<String>,
                    collection: Option<String>,
                }
                let A {
                    path,
                    password,
                    collection,
                } = args(a)?;
                let bytes = std::fs::read(&path).map_err(|e| format!("Couldn't open the file: {e}"))?;
                let r = crate::share::import_share(
                    &self.root,
                    &bytes,
                    password.as_deref(),
                    collection.as_deref(),
                )?;
                self.reload()?;
                to_json(r)
            }
            "reload" => {
                self.reload()?;
                to_json(self.ws.info())
            }
            other => Err(format!("unknown command: {other}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lib() -> (tempfile::TempDir, Session) {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        std::fs::create_dir_all(r.join("Biology")).unwrap();
        std::fs::create_dir_all(r.join("Physics")).unwrap();
        std::fs::write(
            r.join("Biology/Cells.md"),
            "# Cells\nCells have membranes. See [[Osmosis]].",
        )
        .unwrap();
        std::fs::write(r.join("Biology/Osmosis.md"), "Water crosses membranes.").unwrap();
        std::fs::write(r.join("Physics/Energy.md"), "Energy and membranes of soap.").unwrap();
        std::fs::write(r.join("Quick.md"), "loose note").unwrap();
        let s = Session::open(r).unwrap();
        (d, s)
    }

    fn call(s: &mut Session, cmd: &str, args: Value) -> Value {
        s.dispatch(cmd, args).unwrap_or_else(|e| panic!("{cmd}: {e}"))
    }

    fn id_of(s: &mut Session, title: &str) -> String {
        let notes = call(s, "list_notes", json!({}));
        notes
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["title"] == title)
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .into()
    }

    #[test]
    fn open_creates_cerebra_folder_and_index() {
        let (d, _s) = lib();
        assert!(d.path().join(".cerebra/library.json").is_file());
        assert!(d.path().join(".cerebra/index.db").is_file());
    }

    #[test]
    fn library_info_lists_collections() {
        let (_d, mut s) = lib();
        let i = call(&mut s, "library_info", json!({}));
        assert_eq!(i["notes"], 4);
        assert_eq!(
            i["collections"],
            json!([{"name": "Biology", "notes": 2}, {"name": "Physics", "notes": 1}])
        );
        let only_bio = call(&mut s, "list_notes", json!({"collection": "Biology"}));
        assert_eq!(only_bio.as_array().unwrap().len(), 2);
    }

    #[test]
    fn get_note_has_html_links_and_backlinks() {
        let (_d, mut s) = lib();
        let id = id_of(&mut s, "Osmosis");
        let v = call(&mut s, "get_note", json!({"id": id}));
        assert_eq!(v["backlinks"][0]["title"], "Cells");
        assert_eq!(v["text"], "Water crosses membranes.");
        assert_eq!(v["ai_connections"], json!([]));
        assert!(s.dispatch("get_note", json!({"id": "nope"})).is_err());
    }

    #[test]
    fn search_respects_collection() {
        let (_d, mut s) = lib();
        let all = call(&mut s, "search", json!({"query": "membranes"}));
        assert_eq!(all.as_array().unwrap().len(), 3);
        let bio = call(
            &mut s,
            "search",
            json!({"query": "membranes", "collection": "Biology"}),
        );
        assert!(
            bio.as_array()
                .unwrap()
                .iter()
                .all(|h| h["path"].as_str().unwrap().starts_with("Biology/"))
        );
    }

    #[test]
    fn graph_for_collection() {
        let (_d, mut s) = lib();
        let g = call(&mut s, "graph", json!({"collection": "Biology"}));
        let labels: Vec<&str> = g["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n["label"].as_str().unwrap())
            .collect();
        assert!(labels.contains(&"Cells") && labels.contains(&"Osmosis"));
        assert!(!labels.contains(&"Energy"));
        assert_eq!(g["edges"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn upload_returns_note_id_and_indexes_it() {
        use base64::Engine;
        let (_d, mut s) = lib();
        let data = base64::engine::general_purpose::STANDARD.encode("mitochondria make energy");
        let r = call(
            &mut s,
            "upload",
            json!({"collection": "Biology", "name": "mito.txt", "data_base64": data}),
        );
        assert_eq!(r["note_path"], "Biology/mito.md");
        let v = call(&mut s, "get_note", json!({"id": r["note_id"]}));
        assert!(v["text"].as_str().unwrap().contains("mitochondria"));
        let hits = call(&mut s, "search", json!({"query": "mitochondria"}));
        assert_eq!(hits[0]["path"], "Biology/mito.md");
    }

    #[test]
    fn upload_too_large_is_rejected() {
        let (_d, mut s) = lib();
        let huge = "A".repeat(crate::upload::MAX_UPLOAD_BYTES / 3 * 4 + 400);
        let e = s
            .dispatch(
                "upload",
                json!({"collection": "Biology", "name": "big.pdf", "data_base64": huge}),
            )
            .unwrap_err();
        assert!(e.contains("25 MB"), "{e}");
    }

    #[test]
    fn new_note_and_create_collection_reject_bad_names() {
        let (d, mut s) = lib();
        for bad in ["../x", "a/b", "", ".hidden", "CON", "nul", "a:b", "Biology"] {
            assert!(
                s.dispatch("create_collection", json!({"name": bad})).is_err(),
                "collection {bad:?}"
            );
        }
        for bad in ["../x", "a/b", "", ".hidden", "CON"] {
            assert!(
                s.dispatch("new_note", json!({"collection": "Biology", "title": bad}))
                    .is_err(),
                "note {bad:?}"
            );
        }
        assert!(!d.path().join("x").exists() && !d.path().join("x.md").exists());
        assert_eq!(
            call(&mut s, "create_collection", json!({"name": "Chemistry"}))["name"],
            "Chemistry"
        );
        let cols = call(&mut s, "library_info", json!({}))["collections"].clone();
        assert!(
            cols.as_array()
                .unwrap()
                .contains(&json!({"name": "Chemistry", "notes": 0})),
            "{cols}"
        );
        let n = call(
            &mut s,
            "new_note",
            json!({"collection": "Chemistry", "title": "Atoms"}),
        );
        assert_eq!(n["path"], "Chemistry/Atoms.md");
        let n2 = call(
            &mut s,
            "new_note",
            json!({"collection": "Chemistry", "title": "Atoms"}),
        );
        assert_eq!(n2["path"], "Chemistry/Atoms (2).md");
        let root = call(&mut s, "new_note", json!({"title": "Idea"}));
        assert_eq!(root["path"], "Idea.md");
        assert!(
            s.dispatch("new_note", json!({"collection": "Nope", "title": "x"}))
                .is_err()
        );
    }

    #[test]
    fn save_then_reload_reflects_disk() {
        let (d, mut s) = lib();
        let id = id_of(&mut s, "Osmosis");
        let v = call(
            &mut s,
            "save_note",
            json!({"id": id, "text": "Water moves. [[Cells]]"}),
        );
        assert_eq!(v["outgoing"][0]["title"], "Cells");
        assert_eq!(
            std::fs::read_to_string(d.path().join("Biology/Osmosis.md")).unwrap(),
            "Water moves. [[Cells]]"
        );
        std::fs::write(d.path().join("Biology/Osmosis.md"), "Changed outside.").unwrap();
        call(&mut s, "reload", json!({}));
        assert_eq!(
            call(&mut s, "get_note", json!({"id": id}))["text"],
            "Changed outside."
        );
    }

    #[test]
    fn read_file_rejects_escape() {
        let (d, s) = lib();
        std::fs::write(d.path().join("Biology/pic.png"), [1u8, 2]).unwrap();
        let s = {
            drop(s);
            Session::open(d.path()).unwrap()
        };
        assert_eq!(s.read_file("Biology/pic.png"), Some(vec![1, 2]));
        for bad in [
            "../secret",
            "/etc/passwd",
            "Biology/../../x",
            ".cerebra/index.db",
            "%2e%2e/x",
        ] {
            assert_eq!(s.read_file(bad), None, "{bad}");
        }
    }

    #[test]
    fn empty_library_dispatch() {
        let d = tempfile::tempdir().unwrap();
        let mut s = Session::create(&d.path().join("New Library")).unwrap();
        for cmd in ["library_info", "list_notes", "graph", "reload"] {
            call(&mut s, cmd, json!({}));
        }
        assert_eq!(call(&mut s, "search", json!({"query": "anything"})), json!([]));
        let g = call(&mut s, "graph", json!({}));
        assert_eq!(
            (
                g["nodes"].as_array().unwrap().len(),
                g["edges"].as_array().unwrap().len()
            ),
            (0, 0)
        );
        assert_eq!(
            call(&mut s, "context_pack", json!({"question": "x"}))["sources"],
            json!([])
        );
    }

    #[test]
    fn create_refuses_a_file_path() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("file"), "x").unwrap();
        assert!(Session::create(&d.path().join("file")).is_err());
        assert!(Session::open(&d.path().join("missing")).is_err());
    }

    #[test]
    fn unknown_command_is_error() {
        let (_d, mut s) = lib();
        assert!(
            s.dispatch("rm_rf", json!({}))
                .unwrap_err()
                .contains("unknown command")
        );
    }

    fn save_one(s: &mut Session) -> String {
        let r = call(
            s,
            "ai_save_connections",
            json!({
                "connections": [{
                    "from": "Osmosis", "to": "Cells", "type": "explains",
                    "reason": "Osmosis is how water crosses the membranes Cells describes.",
                    "quote_from": "Water crosses membranes", "quote_to": "Cells have membranes"
                }],
                "made_by": {"kind": "agent", "source": "test:model"}
            }),
        );
        assert_eq!(r["rejected"], json!([]), "{r}");
        r["saved"][0].as_str().unwrap().to_string()
    }

    #[test]
    fn note_view_and_graph_include_ai_connections() {
        let (_d, mut s) = lib();
        let cid = save_one(&mut s);
        let cells = id_of(&mut s, "Cells");
        let v = call(&mut s, "get_note", json!({"id": cells}));
        let c = &v["ai_connections"][0];
        assert_eq!(
            (
                c["id"].as_str(),
                c["other_title"].as_str(),
                c["direction"].as_str()
            ),
            (Some(cid.as_str()), Some("Osmosis"), Some("in"))
        );
        assert_eq!(c["type"], "explains");
        assert_eq!(c["evidence"].as_array().unwrap().len(), 2);
        let g = call(&mut s, "graph", json!({}));
        assert_eq!(
            g["ai_edges"],
            json!([["Biology/Osmosis.md", "Biology/Cells.md", "explains", "suggested"]])
        );
        call(
            &mut s,
            "ai_set_status",
            json!({"ids": [cid], "status": "dismissed"}),
        );
        assert_eq!(call(&mut s, "graph", json!({}))["ai_edges"], json!([]));
        assert_eq!(
            call(&mut s, "ai_list", json!({"status": "dismissed"}))["connections"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn ai_list_filters_and_names_notes() {
        let (_d, mut s) = lib();
        save_one(&mut s);
        let all = call(&mut s, "ai_list", json!({}));
        assert_eq!(all["connections"][0]["from_title"], "Osmosis");
        assert_eq!(all["connections"][0]["to_title"], "Cells");
        assert!(all["connections"][0]["from_id"].is_string());
        assert_eq!(
            call(&mut s, "ai_list", json!({"collection": "Physics"}))["connections"],
            json!([])
        );
        assert_eq!(
            call(&mut s, "ai_list", json!({"status": "kept"}))["connections"],
            json!([])
        );
    }

    #[test]
    fn promote_concept_writes_note_with_links() {
        let (d, mut s) = lib();
        let mut layer = crate::ai_layer::AiLayer::load(d.path());
        let id = layer
            .add_concept(
                &s.workspace().vault,
                crate::ai_layer::ConceptInput {
                    title: "Water transport".into(),
                    summary: "How water moves.".into(),
                    collection: "Biology".into(),
                    notes: vec!["Cells".into(), "Osmosis".into()],
                },
                crate::ai_layer::MadeBy {
                    kind: "agent".into(),
                    source: None,
                    job: None,
                },
            )
            .unwrap();
        crate::ai_layer::update(d.path(), |l| *l = layer.clone()).unwrap();
        call(&mut s, "reload", json!({}));
        let g = call(&mut s, "graph", json!({}));
        assert!(
            g["nodes"]
                .as_array()
                .unwrap()
                .iter()
                .any(|n| n["kind"] == "concept" && n["label"] == "Water transport")
        );
        let r = call(&mut s, "ai_promote_concept", json!({"id": id}));
        assert_eq!(r["note_path"], "Biology/Water transport.md");
        let text = std::fs::read_to_string(d.path().join("Biology/Water transport.md")).unwrap();
        assert!(
            text.contains("[[Cells]]") && text.contains("[[Osmosis]]") && text.contains("How water moves.")
        );
        assert_eq!(call(&mut s, "ai_list", json!({}))["concepts"], json!([]));
    }

    #[test]
    fn jobs_commands_round_trip() {
        let (_d, mut s) = lib();
        let id = call(
            &mut s,
            "job_enqueue",
            json!({"kind": "connect_topic", "target": "Osmosis"}),
        )["id"]
            .clone();
        let jobs = call(&mut s, "jobs_list", json!({}));
        assert_eq!(jobs[0]["id"], id);
        assert_eq!(jobs[0]["origin"], "user");
        call(&mut s, "job_cancel", json!({"id": id}));
        assert_eq!(call(&mut s, "jobs_list", json!({}))[0]["status"], "cancelled");
        assert_eq!(call(&mut s, "usage_today", json!({})), json!([]));
        assert!(
            s.dispatch("job_enqueue", json!({"kind": "nope", "target": "x"}))
                .is_err()
        );
    }

    #[test]
    fn candidates_exclude_self_and_linked() {
        let (_d, mut s) = lib();
        // Cells links to Osmosis; both mention membranes, and so does Physics/Energy.
        let c = call(
            &mut s,
            "candidates_for",
            json!({"note": "Cells", "idea": "membranes"}),
        );
        let paths: Vec<&str> = c
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x["path"].as_str().unwrap())
            .collect();
        assert_eq!(paths, vec!["Physics/Energy.md"]);
        assert!(c[0]["text"].as_str().unwrap().contains("membranes"));
        assert!(
            s.dispatch("candidates_for", json!({"note": "Nope", "idea": "x"}))
                .is_err()
        );
    }

    #[test]
    fn changed_notes_since_connected() {
        let (d, mut s) = lib();
        assert_eq!(s.changed_notes().len(), 4);
        s.mark_connected("Biology/Cells.md").unwrap();
        let changed = s.changed_notes();
        assert_eq!(changed.len(), 3);
        assert!(!changed.contains(&"Biology/Cells.md".to_string()));
        std::fs::write(d.path().join("Biology/Cells.md"), "# Cells\nNew text.").unwrap();
        std::fs::write(
            d.path().join("Quick.md"),
            "---\ncerebra: { auto_connect: false }\n---\nloose",
        )
        .unwrap();
        s.reload().unwrap();
        let changed = s.changed_notes();
        assert!(changed.contains(&"Biology/Cells.md".to_string()));
        assert!(!changed.contains(&"Quick.md".to_string()), "opted out");
    }

    #[test]
    fn share_export_inspect_import_commands() {
        let (d, mut s) = lib();
        let file = d.path().join("out/Biology.cerebra");
        std::fs::create_dir_all(d.path().join("out")).unwrap();
        let file = file.to_string_lossy().into_owned();
        call(
            &mut s,
            "share_export",
            json!({"collection": "Biology", "path": file}),
        );
        let p = call(&mut s, "share_inspect", json!({"path": file}));
        assert_eq!(p["counts"]["notes"], 2);
        let r = call(
            &mut s,
            "share_import",
            json!({"path": file, "collection": "Bio copy"}),
        );
        assert_eq!(r["collection"], "Bio copy");
        assert!(
            call(&mut s, "list_notes", json!({"collection": "Bio copy"}))
                .as_array()
                .unwrap()
                .len()
                == 2
        );
        assert!(
            s.dispatch(
                "share_export",
                json!({"collection": "Biology", "path": "relative.cerebra"})
            )
            .is_err()
        );
    }

    #[test]
    fn only_the_app_session_requeues_running_jobs() {
        let (d, s) = lib();
        let id = s
            .jobs()
            .enqueue("connect_note", "Biology/Cells.md", "user")
            .unwrap();
        s.jobs().next().unwrap();
        let side = Session::open_with(d.path(), true).unwrap(); // a `cerebra mcp` process
        assert_eq!(side.jobs().get(&id).unwrap().unwrap().status, "running");
        drop(side);
        drop(s);
        let app = Session::open(d.path()).unwrap();
        assert_eq!(app.jobs().get(&id).unwrap().unwrap().status, "queued");
    }
}
