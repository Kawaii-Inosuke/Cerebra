//! Browser preview: serves the built UI, `POST /api/dispatch` (the same `Session::dispatch`
//! the desktop app uses), stubs for the desktop-only commands under `POST /api/app/<cmd>`,
//! and library files under `GET /file/<path>`. Development only.
//!
//! Binds to 127.0.0.1 and rejects requests whose Host header isn't localhost (blocks
//! DNS-rebinding pages from reading the library).

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use cerebra_core::api::mime_for;
use cerebra_core::parse::percent_decode;
use cerebra_core::session::Session;
use serde_json::{Value, json};
use tiny_http::{Header, Method, Request, Response, Server};

/// Uploads are base64 JSON; 25 MB files → ~34 MB bodies.
const MAX_BODY: usize = 40 * 1024 * 1024;

pub fn serve(mut session: Session, ui_dir: &Path, port: u16) -> Result<()> {
    let ui_dir = ui_dir.canonicalize().with_context(|| {
        format!(
            "UI folder not found: {} (run `npm run build` first)",
            ui_dir.display()
        )
    })?;
    let addr = format!("127.0.0.1:{port}");
    let server = Server::http(&addr).map_err(|e| anyhow::anyhow!("cannot listen on {addr}: {e}"))?;
    println!(
        "Cerebra preview: http://{addr}  (library {})",
        session.root().display()
    );
    println!("Press Ctrl+C to stop.");

    for mut req in server.incoming_requests() {
        if !host_ok(&req, port) {
            let _ = req.respond(Response::from_string("forbidden").with_status_code(403));
            continue;
        }
        let full = req.url().to_string();
        let url = full.split_once('?').map(|x| x.0).unwrap_or(&full).to_string();
        let resp: Resp = if let Some(rest) = url.strip_prefix("/api/") {
            if *req.method() != Method::Post {
                json_error(405, "use POST")
            } else if !header_is(&req, "Content-Type", |v| v.starts_with("application/json")) {
                // Other web pages can only send "simple" cross-site requests (text/plain etc.).
                json_error(415, "send JSON")
            } else if !origin_ok(&req, port) {
                json_error(403, "forbidden")
            } else if req.body_length().unwrap_or(0) > MAX_BODY {
                json_error(413, "That file is larger than 25 MB")
            } else {
                let mut body = String::new();
                let _ = req.as_reader().read_to_string(&mut body);
                let body: Value = serde_json::from_str(&body).unwrap_or(json!({}));
                let result = if rest == "dispatch" {
                    let cmd = body["cmd"].as_str().unwrap_or_default().to_string();
                    session.dispatch(&cmd, body["args"].clone())
                } else if let Some(cmd) = rest.strip_prefix("app/") {
                    app_command(&session, cmd)
                } else {
                    Err("unknown endpoint".into())
                };
                match result {
                    Ok(v) => Response::from_string(v.to_string())
                        .with_header(header("Content-Type", "application/json")),
                    Err(e) => json_error(400, &e),
                }
            }
        } else if let Some(rel) = url.strip_prefix("/file/") {
            let rel = percent_decode(rel);
            match session.read_file(&rel) {
                Some(bytes) => Response::from_data(bytes)
                    .with_header(header("Content-Type", mime_for(&rel)))
                    .with_header(header("X-Content-Type-Options", "nosniff")),
                None => Response::from_data(Vec::new()).with_status_code(404),
            }
        } else {
            static_file(&ui_dir, &url)
        };
        let _ = req.respond(resp);
    }
    Ok(())
}

/// The desktop-only commands, as the preview can answer them.
fn app_command(session: &Session, cmd: &str) -> Result<Value, String> {
    match cmd {
        "app_state" => {
            let models = if cerebra_core::semantic::configured() {
                "ready"
            } else {
                "missing"
            };
            Ok(json!({
                "library": session.root().to_string_lossy(),
                "recent": [session.root().to_string_lossy()],
                "models": models,
                "preview": true,
            }))
        }
        "open_library" | "create_library" | "download_models" => {
            Err("Not available in the browser preview; restart `cerebra <library> serve` instead.".into())
        }
        other => Err(format!("unknown command: {other}")),
    }
}

type Resp = Response<std::io::Cursor<Vec<u8>>>;

fn static_file(ui_dir: &Path, url: &str) -> Resp {
    let rel = percent_decode(url.trim_start_matches('/'));
    let rel = if rel.is_empty() {
        "index.html".to_string()
    } else {
        rel
    };
    let candidate: PathBuf = ui_dir.join(&rel);
    // Only files that really live inside the UI folder; anything else is the app (SPA routes).
    let path = match candidate.canonicalize() {
        Ok(p) if p.starts_with(ui_dir) && p.is_file() => p,
        _ => ui_dir.join("index.html"),
    };
    match std::fs::read(&path) {
        Ok(bytes) => {
            let ct = match path.extension().and_then(|e| e.to_str()) {
                Some("html") => "text/html; charset=utf-8",
                Some("js") => "text/javascript",
                Some("css") => "text/css",
                Some("svg") => "image/svg+xml",
                Some("png") => "image/png",
                Some("woff2") => "font/woff2",
                Some("woff") => "font/woff",
                _ => "application/octet-stream",
            };
            // The page itself is never cached, so a rebuilt UI shows up on reload.
            let cache = if ct.starts_with("text/html") {
                "no-cache"
            } else {
                "max-age=60"
            };
            Response::from_data(bytes)
                .with_header(header("Content-Type", ct))
                .with_header(header("Cache-Control", cache))
        }
        Err(_) => Response::from_data(Vec::new()).with_status_code(404),
    }
}

fn host_ok(req: &Request, port: u16) -> bool {
    req.headers()
        .iter()
        .find(|h| h.field.equiv("Host"))
        .is_some_and(|h| {
            let v = h.value.as_str();
            v == format!("127.0.0.1:{port}") || v == format!("localhost:{port}")
        })
}

fn header_is(req: &Request, name: &'static str, ok: impl Fn(&str) -> bool) -> bool {
    req.headers()
        .iter()
        .find(|h| h.field.equiv(name))
        .is_some_and(|h| ok(&h.value.as_str().to_ascii_lowercase()))
}

/// No Origin (same-origin fetch from older browsers, curl) or this preview's own origin.
fn origin_ok(req: &Request, port: u16) -> bool {
    match req.headers().iter().find(|h| h.field.equiv("Origin")) {
        None => true,
        Some(h) => {
            let v = h.value.as_str();
            v == format!("http://127.0.0.1:{port}") || v == format!("http://localhost:{port}")
        }
    }
}

fn json_error(code: u16, msg: &str) -> Resp {
    Response::from_string(Value::String(msg.to_string()).to_string())
        .with_status_code(code)
        .with_header(header("Content-Type", "application/json"))
}

fn header(k: &str, v: &str) -> Header {
    Header::from_bytes(k.as_bytes(), v.as_bytes()).expect("valid header")
}
