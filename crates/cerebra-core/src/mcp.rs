//! **Cerebra's connector**: an MCP server (Model Context Protocol over stdio) that AI apps
//! (Claude Desktop, Claude Code, Codex, Cursor) and Cerebra's own Strands agents start as
//! `cerebra mcp`. Tools read the library and save AI connections into the AI layer; there
//! is no tool that edits or deletes the user's notes (docs/07-CONNECTOR-MCP.md).

use std::hash::{Hash, Hasher};
use std::io::{BufRead, Write};
use std::path::Path;

use serde_json::{Value, json};

use crate::session::Session;

const SUPPORTED_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const PAGE_CHARS: usize = 9_000;
const MAX_RESULT_CHARS: usize = 24_000;
pub const MAX_NOTES_PER_SESSION: usize = 20;
pub const MAX_CONNECTIONS_PER_SESSION: usize = 60;
pub const MAX_JOBS_PER_SESSION: usize = 10;

pub const INSTRUCTIONS: &str = "Cerebra is the user's own library of notes, PDFs and slides, organised in collections (subjects, courses or projects), with connections between ideas.

How to answer:
- Start with search or get_context (they return the best passages in few tokens). Use read_note only for the notes that matter, with the heading argument for one section of a long note. Use related to follow links and AI connections.
- Answer only from Cerebra and name the notes you used. Say clearly when the library doesn't cover something.

Growing the library:
- When the user asks you to connect notes (a note, a collection or a topic), make the connections yourself: read the notes (overview, then read_note or search), then save each genuine connection with save_connections. Use connect only when the user asks for Cerebra's own agents to do it.
- When two passages are genuinely connected and not linked yet, save the connection with save_connections: exact short quotes from both notes, a type, and a one-line reason a student would find useful. Never save a connection just to save something; saving nothing is fine. Quotes are checked against the notes and rejected if they aren't really there.
- add_note saves a new note (for example a summary the user asked for); Cerebra then connects it automatically.
- connect only queues a job for Cerebra's own agents. They run inside the Cerebra app with the user's AI sources (API keys or a local model), so a job waits while the app is closed or has no AI source.
- You can't edit or delete the user's notes; AI connections live in a separate layer the user reviews.";

const NOTE: &str = "Note title, path (e.g. Biology/Cells.md) or id";

fn tools(agent: bool) -> Value {
    let s = |props: Value, req: &[&str]| json!({ "type": "object", "properties": props, "required": req });
    let conn = json!({
        "type": "object",
        "properties": {
            "from": { "type": "string", "description": NOTE },
            "to": { "type": "string", "description": NOTE },
            "type": { "type": "string", "enum": crate::ai_layer::TYPES },
            "reason": { "type": "string", "description": "One line: how they connect and why it helps" },
            "quote_from": { "type": "string", "description": "Exact short quote from the 'from' note" },
            "quote_to": { "type": "string", "description": "Exact short quote from the 'to' note" },
            "confidence": { "type": "number" }
        },
        "required": ["from", "to", "type", "reason", "quote_from", "quote_to"]
    });
    let mut list = vec![
        json!({ "name": "list_collections", "description": "The library's collections with note counts.", "inputSchema": s(json!({}), &[]) }),
        json!({ "name": "overview", "description": "One collection: its notes (with link counts) and concept notes.",
                "inputSchema": s(json!({ "collection": { "type": "string" } }), &["collection"]) }),
        json!({ "name": "search", "description": "Search notes by keywords and meaning; best passages first.",
                "inputSchema": s(json!({ "query": { "type": "string" }, "collection": { "type": "string" }, "limit": { "type": "integer", "maximum": 12 } }), &["query"]) }),
        json!({ "name": "read_note", "description": "A note's text, or one section of it (heading). Long notes come in pages.",
                "inputSchema": s(json!({ "note": { "type": "string", "description": NOTE }, "heading": { "type": "string" }, "page": { "type": "integer", "minimum": 1 } }), &["note"]) }),
        json!({ "name": "related", "description": "A note's links, backlinks and AI connections (with type and reason).",
                "inputSchema": s(json!({ "note": { "type": "string", "description": NOTE } }), &["note"]) }),
        json!({ "name": "get_context", "description": "The best passages for a question, within a token budget.",
                "inputSchema": s(json!({ "question": { "type": "string" }, "collection": { "type": "string" }, "budget": { "type": "integer", "maximum": 4000 } }), &["question"]) }),
        json!({ "name": "add_note", "description": "Save a new Markdown note (Cerebra then connects it).",
                "inputSchema": s(json!({ "collection": { "type": "string" }, "title": { "type": "string" }, "text": { "type": "string" } }), &["title", "text"]) }),
        json!({ "name": "connect", "description": "Queue a job for Cerebra's own agents to connect a note, a collection or a topic. Runs only while the Cerebra app is open with an AI source set up. To connect notes now, read them and use save_connections instead.",
                "inputSchema": s(json!({ "kind": { "type": "string", "enum": crate::jobs::KINDS }, "target": { "type": "string" } }), &["kind", "target"]) }),
        json!({ "name": "job_status", "description": "Status of a connect job.", "inputSchema": s(json!({ "job_id": { "type": "string" } }), &["job_id"]) }),
        json!({ "name": "save_connections", "description": "Save genuine connections between existing notes, with exact quotes from both.",
                "inputSchema": s(json!({ "connections": { "type": "array", "items": conn } }), &["connections"]) }),
        json!({ "name": "save_concept_note", "description": "Save a concept note that ties together notes about one idea.",
                "inputSchema": s(json!({ "title": { "type": "string" }, "summary": { "type": "string" }, "collection": { "type": "string" }, "notes": { "type": "array", "items": { "type": "string" } } }), &["title", "summary", "collection", "notes"]) }),
        json!({ "name": "list_ai_connections", "description": "AI connections, for a note or a collection.",
                "inputSchema": s(json!({ "note": { "type": "string" }, "collection": { "type": "string" } }), &[]) }),
        json!({ "name": "remove_ai_connections", "description": "Dismiss AI connections by id.",
                "inputSchema": s(json!({ "ids": { "type": "array", "items": { "type": "string" } } }), &["ids"]) }),
    ];
    if agent {
        list.push(json!({ "name": "candidates_for", "description": "Passages from other, not-yet-linked notes that may relate to an idea in a note.",
            "inputSchema": s(json!({ "note": { "type": "string" }, "idea": { "type": "string" }, "limit": { "type": "integer" } }), &["note", "idea"]) }));
    }
    Value::Array(list)
}

fn prompts() -> Value {
    let col = json!([{ "name": "collection", "description": "Collection name", "required": true }]);
    let topic = json!([{ "name": "topic", "description": "Topic", "required": true }]);
    json!([
        { "name": "study_guide", "title": "Study guide", "description": "A revision guide for a collection, citing your notes.", "arguments": col },
        { "name": "explain_with_my_notes", "title": "Explain with my notes", "description": "Explain a topic using only your library.", "arguments": topic },
        { "name": "find_missing_links", "title": "Find missing connections", "description": "Read a collection and save the connections that are missing.", "arguments": col },
        { "name": "save_session", "title": "Save what we learned", "description": "Save the connections found in this conversation." },
        { "name": "quiz_me", "title": "Quiz me", "description": "Questions from a collection, with answers from your notes.", "arguments": col }
    ])
}

fn prompt_text(name: &str, a: &Value) -> Option<String> {
    let c = a
        .get("collection")
        .and_then(Value::as_str)
        .unwrap_or("the library");
    let t = a.get("topic").and_then(Value::as_str).unwrap_or("this topic");
    Some(match name {
        "study_guide" => format!("Using only my Cerebra notes, make a revision guide for the collection \"{c}\": main ideas in a sensible order, how they connect (use related and the AI connections), and what to revise first. Cite the note for each point."),
        "explain_with_my_notes" => format!("Explain \"{t}\" using only my Cerebra notes. Start with get_context, follow related notes where useful, and cite every note you use. Say what my notes don't cover."),
        "find_missing_links" => format!("Read the notes in the collection \"{c}\" (overview, then read_note) and save the genuine connections that are missing with save_connections, with exact quotes from both notes. Prefer a few strong connections over many weak ones."),
        "save_session" => "Look back over this conversation. For each genuine connection between notes we used that isn't linked yet, call save_connections with exact quotes and a one-line reason. If there are none, say so.".into(),
        "quiz_me" => format!("Quiz me on the collection \"{c}\" using only my Cerebra notes: ask one question at a time, wait for my answer, then give the right answer with the note it comes from."),
        _ => return None,
    })
}

fn txt(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn client_label(name: &str) -> String {
    let l = name.to_lowercase();
    if l.contains("claude") {
        "Claude".into()
    } else if l.contains("codex") {
        "Codex".into()
    } else if l.contains("cursor") {
        "Cursor".into()
    } else {
        "AI app".into()
    }
}

/// A cheap fingerprint of the library's files (paths, sizes, change times).
fn fingerprint(root: &Path) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for e in walkdir::WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| {
            e.depth() == 0
                || !(e.file_type().is_dir() && crate::vault::is_ignored_dir(&e.file_name().to_string_lossy()))
        })
        .flatten()
    {
        if let Ok(m) = e.metadata() {
            e.path().hash(&mut h);
            m.len().hash(&mut h);
            m.modified().ok().hash(&mut h);
        }
    }
    h.finish()
}

pub struct Server {
    session: Session,
    agent: bool,
    /// Collections the caller may not see (local-only collections while a cloud AI is working).
    excluded: Vec<String>,
    client: String,
    notes_written: usize,
    connections_written: usize,
    jobs_queued: usize,
    seen: u64,
}

impl Server {
    /// Serve the library at `root`. `agent` adds the agent-only tools (for Cerebra's own agents).
    pub fn open(root: &Path, agent: bool) -> Result<Server, String> {
        let session = Session::open_with(root, true)?;
        let seen = fingerprint(session.root());
        Ok(Server {
            session,
            agent,
            excluded: Vec::new(),
            client: "AI app".into(),
            notes_written: 0,
            connections_written: 0,
            jobs_queued: 0,
            seen,
        })
    }

    /// Hide these collections completely (their notes are never read, searched or listed).
    pub fn excluding(mut self, collections: Vec<String>) -> Server {
        self.excluded = collections;
        self
    }

    fn allowed(&self, path: &str) -> bool {
        crate::collection::collection_of(path).is_none_or(|c| !self.excluded.contains(&c))
    }

    fn check_note(&self, note: &str) -> Result<(), String> {
        match self.session.workspace().vault.find_note(note) {
            Some(n) if self.allowed(&n.path) => Ok(()),
            _ => Err(format!("Note not found: {note}")),
        }
    }

    fn refresh(&mut self) {
        let now = fingerprint(self.session.root());
        if now != self.seen {
            self.seen = now;
            let _ = self.session.reload();
        } else {
            self.session.reload_ai();
        }
    }

    fn call(&mut self, cmd: &str, args: Value) -> Result<Value, String> {
        self.session.dispatch(cmd, args)
    }

    fn tool(&mut self, name: &str, a: &Value) -> Result<String, String> {
        let pretty = |v: Value| serde_json::to_string_pretty(&v).unwrap_or_default();
        match name {
            "list_collections" => {
                let all = self.call("library_info", json!({}))?["collections"].clone();
                let shown: Vec<Value> = all
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|c| !self.excluded.iter().any(|x| c["name"] == x.as_str()))
                    .cloned()
                    .collect();
                Ok(pretty(Value::Array(shown)))
            }
            "overview" => {
                let c = txt(a, "collection");
                if self.excluded.contains(&c) {
                    return Err(format!("Collection not found or empty: {c}"));
                }
                let ws = self.session.workspace();
                let notes: Vec<Value> = ws
                    .vault
                    .notes
                    .iter()
                    .filter(|n| crate::collection::collection_of(&n.path).as_deref() == Some(c.as_str()))
                    .map(|n| {
                        let links = ws.index.resolved.get(&n.path).map(|m| m.len()).unwrap_or(0)
                            + ws.index.backlinks(&n.path).len();
                        json!({ "title": n.title, "path": n.path, "links": links })
                    })
                    .collect();
                if notes.is_empty() {
                    return Err(format!("Collection not found or empty: {c}"));
                }
                let concepts: Vec<String> = ws
                    .ai
                    .visible_concepts(&ws.vault)
                    .into_iter()
                    .filter(|k| k.collection == c)
                    .map(|k| k.title)
                    .collect();
                Ok(pretty(
                    json!({ "collection": c, "notes": notes, "concepts": concepts }),
                ))
            }
            "search" => {
                let limit = a.get("limit").and_then(Value::as_u64).unwrap_or(8).clamp(1, 12);
                let ask = if self.excluded.is_empty() {
                    limit
                } else {
                    limit * 4
                };
                let hits = self.call(
                    "search",
                    json!({ "query": txt(a, "query"), "collection": a.get("collection"), "limit": ask }),
                )?;
                let out: Vec<Value> = hits
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|h| self.allowed(h["path"].as_str().unwrap_or_default()))
                    .take(limit as usize)
                    .map(|h| json!({ "title": h["title"], "path": h["path"], "heading_path": h["heading_path"], "score": h["score"], "text": h["snippet"] }))
                    .collect();
                Ok(pretty(Value::Array(out)))
            }
            "read_note" => {
                let note = txt(a, "note");
                self.check_note(&note)?;
                let heading = a.get("heading").and_then(Value::as_str);
                let t = self
                    .session
                    .workspace()
                    .note_text(&note, heading)
                    .map_err(|_| format!("Note not found: {note}"))?;
                let page = a.get("page").and_then(Value::as_u64).unwrap_or(1).max(1) as usize;
                let chars: Vec<char> = t.text.chars().collect();
                let pages = chars.len().div_ceil(PAGE_CHARS).max(1);
                let start = (page - 1) * PAGE_CHARS;
                let body: String = chars.iter().skip(start).take(PAGE_CHARS).collect();
                let more = if page < pages {
                    format!("\n\n(Page {page} of {pages}; read page {} for more.)", page + 1)
                } else {
                    String::new()
                };
                Ok(format!("# {} ({})\n\n{body}{more}", t.title, t.path))
            }
            "related" => {
                let note = txt(a, "note");
                self.check_note(&note)?;
                let id = self
                    .session
                    .workspace()
                    .find_note(&note)
                    .ok_or_else(|| format!("Note not found: {note}"))?;
                let v = self.call("get_note", json!({ "id": id }))?;
                let ok = |l: &Value| {
                    self.allowed(
                        l["path"]
                            .as_str()
                            .or(l["other_path"].as_str())
                            .unwrap_or_default(),
                    )
                };
                let links: Vec<Value> = v["outgoing"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|l| l["unresolved"] == false && ok(l))
                    .map(|l| l["title"].clone())
                    .collect();
                let backlinks: Vec<Value> = v["backlinks"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|l| ok(l))
                    .map(|l| l["title"].clone())
                    .collect();
                let ai: Vec<Value> = v["ai_connections"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|c| ok(c))
                    .map(|c| json!({ "title": c["other_title"], "type": c["type"], "reason": c["reason"], "status": c["status"], "direction": c["direction"] }))
                    .collect();
                Ok(pretty(
                    json!({ "note": v["title"], "links": links, "backlinks": backlinks, "ai_connections": ai }),
                ))
            }
            "get_context" => {
                if !self.excluded.is_empty() {
                    return Err("get_context isn't available here; use search and read_note".into());
                }
                let budget = a
                    .get("budget")
                    .and_then(Value::as_u64)
                    .unwrap_or(2500)
                    .clamp(300, 4000) as usize;
                let ws = self.session.workspace();
                let p = crate::context::build_context(
                    &ws.vault,
                    &ws.index,
                    &ws.store,
                    &txt(a, "question"),
                    a.get("collection").and_then(Value::as_str),
                    budget,
                )
                .map_err(|e| e.to_string())?;
                Ok(p.text)
            }
            "add_note" => {
                if self.notes_written >= MAX_NOTES_PER_SESSION {
                    return Err(format!(
                        "This conversation reached the limit of {MAX_NOTES_PER_SESSION} new notes"
                    ));
                }
                let r = self.call(
                    "new_note",
                    json!({ "collection": a.get("collection"), "title": txt(a, "title") }),
                )?;
                let path = r["path"].as_str().unwrap_or_default().to_string();
                let body = txt(a, "text");
                let text = format!(
                    "---\ncreated_by: assistant\ncreated: {}\n---\n{}\n",
                    crate::time::now_iso(),
                    body.trim_end()
                );
                std::fs::write(self.session.root().join(&path), text)
                    .map_err(|e| format!("Couldn't save: {e}"))?;
                self.session.reload()?;
                self.seen = fingerprint(self.session.root());
                self.notes_written += 1;
                let job = self.session.jobs().enqueue("connect_note", &path, "assistant")?;
                Ok(pretty(json!({ "path": path, "connect_job": job })))
            }
            "connect" => {
                if !self.agent && self.jobs_queued >= MAX_JOBS_PER_SESSION {
                    return Err(format!(
                        "This conversation reached the limit of {MAX_JOBS_PER_SESSION} connect requests"
                    ));
                }
                let id = self
                    .session
                    .jobs()
                    .enqueue(&txt(a, "kind"), &txt(a, "target"), "assistant")?;
                self.jobs_queued += 1;
                Ok(pretty(json!({
                    "job_id": id,
                    "note": "Queued for Cerebra's agents. They run in the Cerebra app with the user's AI source (an API key or a local model), so the job waits while the app is closed or no AI source is set up. To connect the notes right away, read them and save the connections yourself with save_connections."
                })))
            }
            "job_status" => {
                let job = self
                    .session
                    .jobs()
                    .get(&txt(a, "job_id"))?
                    .ok_or("Job not found")?;
                Ok(pretty(serde_json::to_value(job).unwrap_or_default()))
            }
            "save_connections" => {
                let list = a.get("connections").cloned().unwrap_or(json!([]));
                let n = list.as_array().map(Vec::len).unwrap_or(0);
                if self.connections_written + n > MAX_CONNECTIONS_PER_SESSION {
                    return Err(format!(
                        "This conversation reached the limit of {MAX_CONNECTIONS_PER_SESSION} saved connections"
                    ));
                }
                let made_by = if self.agent {
                    a.get("made_by").cloned().unwrap_or(json!({ "kind": "agent" }))
                } else {
                    json!({ "kind": "assistant", "source": self.client })
                };
                let status = if self.agent {
                    a.get("status").cloned().unwrap_or(Value::Null)
                } else {
                    Value::Null
                };
                let r = self.call(
                    "ai_save_connections",
                    json!({ "connections": list, "made_by": made_by, "status": status }),
                )?;
                self.connections_written += r["saved"].as_array().map(Vec::len).unwrap_or(0);
                Ok(pretty(r))
            }
            "save_concept_note" => {
                let input: crate::ai_layer::ConceptInput =
                    serde_json::from_value(a.clone()).map_err(|e| format!("bad arguments: {e}"))?;
                let made_by = crate::ai_layer::MadeBy {
                    kind: if self.agent {
                        "agent".into()
                    } else {
                        "assistant".into()
                    },
                    source: Some(self.client.clone()),
                    job: None,
                };
                let root = self.session.root().to_path_buf();
                let vault = &self.session.workspace().vault;
                let id = crate::ai_layer::update(&root, |l| l.add_concept(vault, input, made_by))??;
                self.session.reload_ai();
                Ok(pretty(json!({ "id": id })))
            }
            "list_ai_connections" => {
                let note_id = a
                    .get("note")
                    .and_then(Value::as_str)
                    .and_then(|n| self.session.workspace().find_note(n));
                let r = self.call(
                    "ai_list",
                    json!({ "collection": a.get("collection"), "note_id": note_id }),
                )?;
                Ok(pretty(r))
            }
            "remove_ai_connections" => {
                // Only suggestions can be dismissed here; what the user kept stays kept.
                let asked: Vec<String> = a
                    .get("ids")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect();
                let ids: Vec<String> = self
                    .session
                    .workspace()
                    .ai
                    .connections
                    .iter()
                    .filter(|c| asked.contains(&c.id) && c.status == crate::ai_layer::Status::Suggested)
                    .map(|c| c.id.clone())
                    .collect();
                Ok(pretty(self.call(
                    "ai_set_status",
                    json!({ "ids": ids, "status": "dismissed" }),
                )?))
            }
            "candidates_for" if self.agent => {
                let limit = a.get("limit").and_then(Value::as_u64).unwrap_or(6) as usize;
                let note = txt(a, "note");
                self.check_note(&note)?;
                let ask = if self.excluded.is_empty() {
                    limit
                } else {
                    (limit * 4).min(20)
                };
                let found = self.session.candidates_for(&note, &txt(a, "idea"), ask)?;
                let kept: Vec<Value> = found
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|c| self.allowed(c["path"].as_str().unwrap_or_default()))
                    .take(limit)
                    .cloned()
                    .collect();
                Ok(pretty(Value::Array(kept)))
            }
            other => Err(format!("Unknown tool: {other}")),
        }
    }

    fn handle(&mut self, msg: &Value) -> Option<Value> {
        let id = msg.get("id").cloned()?;
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let params = msg.get("params").cloned().unwrap_or(json!({}));
        let result: Result<Value, (i64, String)> = match method {
            "initialize" => {
                let asked = params
                    .get("protocolVersion")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let version = if SUPPORTED_VERSIONS.contains(&asked) {
                    asked
                } else {
                    SUPPORTED_VERSIONS[1]
                };
                if let Some(n) = params.pointer("/clientInfo/name").and_then(Value::as_str) {
                    self.client = client_label(n);
                }
                Ok(json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false }, "prompts": { "listChanged": false } },
                    "serverInfo": { "name": "cerebra", "title": "Cerebra", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": INSTRUCTIONS,
                }))
            }
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": tools(self.agent) })),
            "prompts/list" => Ok(json!({ "prompts": prompts() })),
            "prompts/get" => {
                let name = txt(&params, "name");
                match prompt_text(&name, params.get("arguments").unwrap_or(&json!({}))) {
                    Some(t) => Ok(
                        json!({ "messages": [{ "role": "user", "content": { "type": "text", "text": t } }] }),
                    ),
                    None => Err((-32602, format!("Unknown prompt: {name}"))),
                }
            }
            "resources/list" => Ok(json!({ "resources": [] })),
            "tools/call" => {
                self.refresh();
                let name = txt(&params, "name");
                let args = params.get("arguments").cloned().unwrap_or(json!({}));
                let (text, is_error) = match self.tool(&name, &args) {
                    Ok(t) if t.chars().count() > MAX_RESULT_CHARS => (
                        t.chars().take(MAX_RESULT_CHARS).collect::<String>() + "\n…(cut)",
                        false,
                    ),
                    Ok(t) => (t, false),
                    Err(e) => (e, true),
                };
                Ok(json!({ "content": [{ "type": "text", "text": text }], "isError": is_error }))
            }
            other => Err((-32601, format!("Method not found: {other}"))),
        };
        Some(match result {
            Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
            Err((code, message)) => {
                json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
            }
        })
    }
}

/// Run the server: one JSON-RPC message (or batch) per line on `input`, answers on `output`.
pub fn serve(server: &mut Server, input: impl BufRead, mut output: impl Write) -> std::io::Result<()> {
    for line in input.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(Value::Array(batch)) => {
                let replies: Vec<Value> = batch.iter().filter_map(|m| server.handle(m)).collect();
                (!replies.is_empty()).then_some(Value::Array(replies))
            }
            Ok(msg) => server.handle(&msg),
            Err(e) => Some(
                json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": format!("Parse error: {e}") } }),
            ),
        };
        if let Some(r) = reply {
            writeln!(output, "{}", serde_json::to_string(&r).unwrap_or_default())?;
            output.flush()?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lib() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        std::fs::create_dir_all(r.join("Biology")).unwrap();
        std::fs::write(
            r.join("Biology/Cells.md"),
            "# Cells\nCells have membranes. See [[Osmosis]].",
        )
        .unwrap();
        std::fs::write(
            r.join("Biology/Osmosis.md"),
            "# Osmosis\nWater crosses membranes by osmosis.",
        )
        .unwrap();
        std::fs::write(r.join("Biology/Plants.md"), "Plants take in water through roots.").unwrap();
        d
    }

    fn rpc(server: &mut Server, msgs: &[Value]) -> Vec<Value> {
        let input: String = msgs.iter().map(|m| format!("{m}\n")).collect();
        let mut out = Vec::new();
        serve(server, input.as_bytes(), &mut out).unwrap();
        String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    fn tool(server: &mut Server, name: &str, args: Value) -> (String, bool) {
        let r = rpc(
            server,
            &[json!({"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":name,"arguments":args}})],
        );
        let res = &r[0]["result"];
        (
            res["content"][0]["text"].as_str().unwrap_or_default().to_string(),
            res["isError"] == true,
        )
    }

    fn tool_names(server: &mut Server) -> Vec<String> {
        let r = rpc(server, &[json!({"jsonrpc":"2.0","id":2,"method":"tools/list"})]);
        r[0]["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn initialize_and_list_tools() {
        let d = lib();
        let mut s = Server::open(d.path(), false).unwrap();
        let r = rpc(
            &mut s,
            &[
                json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"claude-ai"}}}),
                json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            ],
        );
        assert_eq!(r.len(), 1, "notifications get no answer");
        assert_eq!(r[0]["result"]["serverInfo"]["name"], "cerebra");
        assert!(
            r[0]["result"]["instructions"]
                .as_str()
                .unwrap()
                .contains("Cerebra")
        );
        let names = tool_names(&mut s);
        for t in [
            "list_collections",
            "search",
            "read_note",
            "related",
            "get_context",
            "add_note",
            "connect",
            "save_connections",
        ] {
            assert!(names.contains(&t.to_string()), "{t}");
        }
        assert!(!names.contains(&"candidates_for".to_string()));
        let mut agent = Server::open(d.path(), true).unwrap();
        assert!(tool_names(&mut agent).contains(&"candidates_for".to_string()));
        let p = rpc(&mut s, &[json!({"jsonrpc":"2.0","id":3,"method":"prompts/list"})]);
        assert_eq!(p[0]["result"]["prompts"].as_array().unwrap().len(), 5);
    }

    #[test]
    fn search_and_read_note() {
        let d = lib();
        let mut s = Server::open(d.path(), false).unwrap();
        let (t, e) = tool(&mut s, "search", json!({"query": "osmosis"}));
        assert!(!e && t.contains("Biology/Osmosis.md"), "{t}");
        let (t, _) = tool(&mut s, "read_note", json!({"note": "Osmosis"}));
        assert!(t.contains("Water crosses membranes"), "{t}");
        let (t, _) = tool(&mut s, "related", json!({"note": "Osmosis"}));
        assert!(t.contains("Cells"), "{t}");
        let (t, _) = tool(&mut s, "list_collections", json!({}));
        assert!(t.contains("Biology"));
        let (t, e) = tool(&mut s, "read_note", json!({"note": "Nope"}));
        assert!(e && t.contains("not found"));
    }

    #[test]
    fn save_connections_via_mcp_verifies_quotes() {
        let d = lib();
        let mut s = Server::open(d.path(), false).unwrap();
        let (t, e) = tool(
            &mut s,
            "save_connections",
            json!({"connections": [
                {"from": "Plants", "to": "Osmosis", "type": "example_of", "reason": "Roots take in water by osmosis.",
                 "quote_from": "take in water through roots", "quote_to": "Water crosses membranes by osmosis"},
                {"from": "Plants", "to": "Cells", "type": "related", "reason": "made up",
                 "quote_from": "plants photosynthesise", "quote_to": "Cells have membranes"}
            ]}),
        );
        assert!(!e, "{t}");
        let report: Value = serde_json::from_str(&t).unwrap();
        assert_eq!(report["saved"].as_array().unwrap().len(), 1);
        assert_eq!(report["rejected"][0]["reason"], "quote_not_found");
        let layer = crate::ai_layer::AiLayer::load(d.path());
        assert_eq!(layer.connections[0].made_by.kind, "assistant");
        assert_eq!(layer.connections[0].made_by.source.as_deref(), Some("AI app"));
    }

    #[test]
    fn add_note_enqueues_job() {
        let d = lib();
        let mut s = Server::open(d.path(), false).unwrap();
        let (t, e) = tool(
            &mut s,
            "add_note",
            json!({"collection": "Biology", "title": "Summary", "text": "Osmosis and cells."}),
        );
        assert!(!e, "{t}");
        let text = std::fs::read_to_string(d.path().join("Biology/Summary.md")).unwrap();
        assert!(text.starts_with("---\ncreated_by: assistant\n") && text.contains("Osmosis and cells."));
        let jobs = crate::jobs::Jobs::open(d.path()).unwrap().list(5).unwrap();
        assert_eq!(
            (
                jobs[0].kind.as_str(),
                jobs[0].target.as_str(),
                jobs[0].origin.as_str()
            ),
            ("connect_note", "Biology/Summary.md", "assistant")
        );
        let (t, _) = tool(
            &mut s,
            "connect",
            json!({"kind": "connect_topic", "target": "Water"}),
        );
        let id = serde_json::from_str::<Value>(&t).unwrap()["job_id"]
            .as_str()
            .unwrap()
            .to_string();
        let (t, _) = tool(&mut s, "job_status", json!({"job_id": id}));
        assert!(t.contains("queued"));
    }

    #[test]
    fn connect_says_what_it_needs_and_offers_doing_it_directly() {
        let d = lib();
        let mut s = Server::open(d.path(), false).unwrap();
        let (t, e) = tool(
            &mut s,
            "connect",
            json!({"kind": "connect_collection", "target": "Biology"}),
        );
        assert!(!e);
        let v: Value = serde_json::from_str(&t).unwrap();
        let note = v["note"].as_str().unwrap();
        assert!(
            note.contains("AI source") && note.contains("Cerebra app"),
            "{note}"
        );
        assert!(note.contains("save_connections"), "{note}");
    }

    #[test]
    fn instructions_ask_the_assistant_to_connect_notes_itself() {
        assert!(INSTRUCTIONS.contains("make the connections yourself"));
        let list = tools(false);
        let connect = list
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == "connect")
            .unwrap();
        assert!(connect["description"].as_str().unwrap().contains("AI source"));
    }

    #[test]
    fn session_write_limit() {
        let d = lib();
        let mut s = Server::open(d.path(), false).unwrap();
        for i in 0..MAX_NOTES_PER_SESSION {
            let (_, e) = tool(&mut s, "add_note", json!({"title": format!("n{i}"), "text": "x"}));
            assert!(!e);
        }
        let (t, e) = tool(&mut s, "add_note", json!({"title": "one too many", "text": "x"}));
        assert!(e && t.contains("limit"), "{t}");
    }

    #[test]
    fn agent_mode_sees_candidates_and_saves_as_agent() {
        let d = lib();
        let mut s = Server::open(d.path(), true).unwrap();
        let (t, e) = tool(
            &mut s,
            "candidates_for",
            json!({"note": "Plants", "idea": "water osmosis"}),
        );
        assert!(!e && t.contains("Osmosis"), "{t}");
        tool(
            &mut s,
            "save_connections",
            json!({"connections": [{"from": "Plants", "to": "Osmosis", "type": "example_of", "reason": "r",
                "quote_from": "take in water through roots", "quote_to": "Water crosses membranes"}],
                "made_by": {"kind": "agent", "source": "groq:llama", "job": "j_1"}}),
        );
        let c = &crate::ai_layer::AiLayer::load(d.path()).connections[0];
        assert_eq!(
            (c.made_by.kind.as_str(), c.made_by.source.as_deref()),
            ("agent", Some("groq:llama"))
        );
    }

    #[test]
    fn unknown_tool_is_error_result_and_unknown_method_is_rpc_error() {
        let d = lib();
        let mut s = Server::open(d.path(), false).unwrap();
        let (t, e) = tool(&mut s, "delete_note", json!({}));
        assert!(e && t.contains("Unknown tool"));
        let r = rpc(&mut s, &[json!({"jsonrpc":"2.0","id":9,"method":"nope"})]);
        assert_eq!(r[0]["error"]["code"], -32601);
        let bad = rpc_raw(&mut s, "{not json\n");
        assert_eq!(bad[0]["error"]["code"], -32700);
    }

    fn rpc_raw(server: &mut Server, input: &str) -> Vec<Value> {
        let mut out = Vec::new();
        serve(server, input.as_bytes(), &mut out).unwrap();
        String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    #[test]
    fn excluded_collections_are_invisible_to_the_agents() {
        let d = lib();
        std::fs::create_dir_all(d.path().join("Health")).unwrap();
        std::fs::write(
            d.path().join("Health/Stress.md"),
            "Stress and water intake, osmosis of cells.",
        )
        .unwrap();
        let mut s = Server::open(d.path(), true)
            .unwrap()
            .excluding(vec!["Health".into()]);
        let (t, _) = tool(&mut s, "search", json!({"query": "osmosis"}));
        assert!(!t.contains("Health/"), "{t}");
        let (t, e) = tool(&mut s, "read_note", json!({"note": "Health/Stress.md"}));
        assert!(e && !t.contains("Stress and water"), "{t}");
        let (t, _) = tool(
            &mut s,
            "candidates_for",
            json!({"note": "Plants", "idea": "osmosis water cells"}),
        );
        assert!(!t.contains("Health/"), "{t}");
        let (t, _) = tool(&mut s, "list_collections", json!({}));
        assert!(!t.contains("Health"), "{t}");
        let (t, e) = tool(&mut s, "related", json!({"note": "Stress"}));
        assert!(e, "{t}");
        let (_, e) = tool(&mut s, "get_context", json!({"question": "osmosis"}));
        assert!(e, "get_context isn't offered while collections are excluded");
    }

    #[test]
    fn ai_apps_can_only_dismiss_suggestions_and_queue_a_few_jobs() {
        let d = lib();
        let mut agent = Server::open(d.path(), true).unwrap();
        let (t, _) = tool(
            &mut agent,
            "save_connections",
            json!({"connections": [
                {"from": "Plants", "to": "Osmosis", "type": "example_of", "reason": "r",
                 "quote_from": "take in water through roots", "quote_to": "Water crosses membranes"},
                {"from": "Cells", "to": "Plants", "type": "related", "reason": "r",
                 "quote_from": "Cells have membranes", "quote_to": "Plants take in water"}
            ], "made_by": {"kind": "agent"}}),
        );
        let ids: Vec<String> = serde_json::from_str::<Value>(&t).unwrap()["saved"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap().to_string())
            .collect();
        crate::ai_layer::update(d.path(), |l| {
            l.set_status(&ids[..1], crate::ai_layer::Status::Kept)
        })
        .unwrap();

        let mut s = Server::open(d.path(), false).unwrap();
        let (t, e) = tool(&mut s, "remove_ai_connections", json!({"ids": ids}));
        assert!(!e, "{t}");
        assert_eq!(
            serde_json::from_str::<Value>(&t).unwrap()["changed"],
            1,
            "the kept one stays"
        );
        let layer = crate::ai_layer::AiLayer::load(d.path());
        assert_eq!(
            layer.connections.iter().find(|c| c.id == ids[0]).unwrap().status,
            crate::ai_layer::Status::Kept
        );

        for i in 0..MAX_JOBS_PER_SESSION {
            let (_, e) = tool(
                &mut s,
                "connect",
                json!({"kind": "connect_topic", "target": format!("t{i}")}),
            );
            assert!(!e);
        }
        let (t, e) = tool(
            &mut s,
            "connect",
            json!({"kind": "connect_topic", "target": "one more"}),
        );
        assert!(e && t.contains("limit"), "{t}");
    }
}
