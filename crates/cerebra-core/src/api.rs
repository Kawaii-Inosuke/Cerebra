//! The app-facing API: everything the UI asks for, as plain serialisable structs.
//!
//! Both front doors use this module, so they can never disagree:
//! - the Tauri desktop app (`src-tauri`), via commands
//! - the browser preview (`cerebra <library> serve`), via local HTTP

use std::collections::BTreeSet;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::collection::collection_of;
use crate::graph::{GraphOptions, LinkIndex, NodeKind};
use crate::model::Heading;
use crate::render::Renderer;
use crate::store::{SearchHit, Store};
use crate::vault::Vault;

/// An open library with its link index and search index.
pub struct Workspace {
    pub vault: Vault,
    pub index: LinkIndex,
    pub store: Store,
    /// AI connections and concept notes (empty until the session loads the library's layer).
    pub ai: crate::ai_layer::AiLayer,
}

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error(transparent)]
    Vault(#[from] crate::vault::VaultError),
    #[error("index error: {0}")]
    Store(#[from] rusqlite::Error),
    #[error("note not found")]
    NoteNotFound,
}

#[derive(Serialize)]
pub struct LibraryInfo {
    pub root: String,
    pub name: String,
    pub notes: usize,
    pub files: usize,
    pub collections: Vec<CollectionInfo>,
}

#[derive(Serialize)]
pub struct CollectionInfo {
    pub name: String,
    pub notes: usize,
}

#[derive(Serialize)]
pub struct NoteSummary {
    pub id: String,
    pub path: String,
    pub title: String,
    pub tags: Vec<String>,
    pub collection: Option<String>,
}

#[derive(Serialize)]
pub struct LinkItem {
    pub note_id: Option<String>,
    pub title: String,
    pub path: Option<String>,
    pub unresolved: bool,
    pub count: usize,
}

#[derive(Serialize)]
pub struct BacklinkItem {
    pub note_id: String,
    pub title: String,
    pub path: String,
    /// `(1-based line, line text)` for each mention.
    pub mentions: Vec<(usize, String)>,
}

#[derive(Serialize)]
pub struct NoteView {
    pub id: String,
    pub path: String,
    pub title: String,
    pub html: String,
    /// The Markdown source (for the editor).
    pub text: String,
    pub tags: Vec<String>,
    pub aliases: Vec<String>,
    pub headings: Vec<Heading>,
    pub outgoing: Vec<LinkItem>,
    pub backlinks: Vec<BacklinkItem>,
    /// Library path of the original file for notes made from uploads (`source:` frontmatter).
    pub source_file: Option<String>,
    /// AI connections touching this note (not dismissed), with the other note named.
    pub ai_connections: Vec<serde_json::Value>,
}

#[derive(Deserialize, Default, Debug, Clone)]
#[serde(default)]
pub struct GraphRequest {
    pub unresolved: bool,
    pub tags: bool,
    pub attachments: bool,
    pub hide_orphans: bool,
    /// Note id for a local graph; `None` = global graph.
    pub focus: Option<String>,
    pub depth: Option<usize>,
    /// Only this collection's notes (plus directly linked notes, shown dimmed).
    pub collection: Option<String>,
}

#[derive(Serialize)]
pub struct NoteText {
    pub id: String,
    pub path: String,
    pub title: String,
    pub collection: Option<String>,
    pub text: String,
    pub headings: Vec<String>,
    pub links_to: Vec<String>,
    pub linked_from: Vec<String>,
}

#[derive(Serialize)]
pub struct GraphNodeOut {
    pub key: String,
    pub label: String,
    pub kind: NodeKind,
    pub degree: usize,
    pub note_id: Option<String>,
    pub collection: Option<String>,
    /// Outside the requested collection (context only).
    pub dim: bool,
}

#[derive(Serialize)]
pub struct GraphOut {
    pub nodes: Vec<GraphNodeOut>,
    pub edges: Vec<(String, String, usize)>,
    /// AI connections between shown nodes: (from, to, type, status). Concept nodes link to
    /// their notes with type `concept`.
    pub ai_edges: Vec<(String, String, String, String)>,
}

impl Workspace {
    /// Load the library at `path` with an in-memory index.
    pub fn open(path: impl AsRef<Path>) -> Result<Workspace, ApiError> {
        Workspace::with_store(Vault::load(path)?, Store::open_in_memory()?)
    }

    /// Index an already-built library into `store` (in memory, or `.cerebra/index.db`).
    pub fn with_store(vault: Vault, mut store: Store) -> Result<Workspace, ApiError> {
        let index = LinkIndex::build(&vault);
        store.rebuild(&vault, &index)?;
        Ok(Workspace {
            vault,
            index,
            store,
            ai: Default::default(),
        })
    }

    pub fn info(&self) -> LibraryInfo {
        LibraryInfo {
            collections: {
                // Every top-level folder is a collection, including new empty ones.
                let mut c: std::collections::BTreeMap<String, usize> =
                    crate::collection::collections(&self.vault).into_iter().collect();
                if let Ok(dir) = std::fs::read_dir(&self.vault.root) {
                    for e in dir.flatten() {
                        let name = e.file_name().to_string_lossy().into_owned();
                        if e.file_type().is_ok_and(|t| t.is_dir()) && !crate::vault::is_ignored_dir(&name) {
                            c.entry(name).or_insert(0);
                        }
                    }
                }
                c.into_iter()
                    .map(|(name, notes)| CollectionInfo { name, notes })
                    .collect()
            },
            name: self
                .vault
                .root
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            root: self.vault.root.to_string_lossy().into_owned(),
            notes: self.vault.notes.len(),
            files: self.vault.files.len(),
        }
    }

    pub fn list_notes(&self) -> Vec<NoteSummary> {
        self.vault
            .notes
            .iter()
            .map(|n| NoteSummary {
                id: n.id.clone(),
                path: n.path.clone(),
                title: n.title.clone(),
                tags: n.meta.tags.clone(),
                collection: collection_of(&n.path),
            })
            .collect()
    }

    pub fn get_note(&self, id: &str) -> Result<NoteView, ApiError> {
        let note = self.vault.note_by_id(id).ok_or(ApiError::NoteNotFound)?;
        let html = Renderer::new(&self.vault).render(&note.path).unwrap_or_default();

        let mut outgoing: Vec<LinkItem> = Vec::new();
        if let Some(dsts) = self.index.resolved.get(&note.path) {
            for (dst, count) in dsts {
                let target = self.vault.note_by_path(dst);
                outgoing.push(LinkItem {
                    note_id: target.map(|n| n.id.clone()),
                    title: target
                        .map(|n| n.title.clone())
                        .unwrap_or_else(|| dst.rsplit('/').next().unwrap_or(dst).to_string()),
                    path: Some(dst.clone()),
                    unresolved: false,
                    count: *count,
                });
            }
        }
        if let Some(texts) = self.index.unresolved.get(&note.path) {
            for (text, count) in texts {
                outgoing.push(LinkItem {
                    note_id: None,
                    title: text.clone(),
                    path: None,
                    unresolved: true,
                    count: *count,
                });
            }
        }

        let backlinks = self
            .index
            .backlinks(&note.path)
            .into_iter()
            .filter_map(|(src, edges)| {
                let src_note = self.vault.note_by_path(src)?;
                let lines: Vec<&str> = src_note.text.lines().collect();
                let mut mentions: Vec<(usize, String)> = edges
                    .iter()
                    .map(|e| {
                        let text = lines.get(e.line).copied().unwrap_or("").trim();
                        (e.line + 1, text.chars().take(200).collect())
                    })
                    .collect();
                mentions.dedup();
                Some(BacklinkItem {
                    note_id: src_note.id.clone(),
                    title: src_note.title.clone(),
                    path: src_note.path.clone(),
                    mentions,
                })
            })
            .collect();

        let source_file = note
            .meta
            .frontmatter
            .get("source")
            .and_then(|v| v.as_str())
            .filter(|s| s.starts_with(crate::upload::FILES_DIR))
            .and_then(|s| crate::collection::collection_of(&note.path).map(|c| format!("{c}/{s}")));
        Ok(NoteView {
            text: note.text.clone(),
            source_file,
            ai_connections: self.ai_connections_for(&note.path),
            id: note.id.clone(),
            path: note.path.clone(),
            title: note.title.clone(),
            html,
            tags: note.meta.tags.clone(),
            aliases: note.meta.aliases.clone(),
            headings: note.meta.headings.clone(),
            outgoing,
            backlinks,
        })
    }

    /// A note's Markdown for an AI assistant: the whole note, or one section (`heading`),
    /// plus its links. `query` is a title, alias, path or id.
    pub fn note_text(&self, query: &str, heading: Option<&str>) -> Result<NoteText, ApiError> {
        let note = self.vault.find_note(query).ok_or(ApiError::NoteNotFound)?;
        let body = &note.text[note.meta.body_start.min(note.text.len())..];
        let text = match heading.map(str::trim).filter(|h| !h.is_empty()) {
            None => body.to_string(),
            Some(h) => {
                let hs = &note.meta.headings;
                let pos = hs
                    .iter()
                    .position(|x| x.text.eq_ignore_ascii_case(h))
                    .or_else(|| {
                        hs.iter()
                            .position(|x| x.text.to_lowercase().contains(&h.to_lowercase()))
                    })
                    .ok_or(ApiError::NoteNotFound)?;
                let start = hs[pos].line;
                let end = hs[pos + 1..]
                    .iter()
                    .find(|x| x.level <= hs[pos].level)
                    .map(|x| x.line)
                    .unwrap_or(usize::MAX);
                note.text
                    .lines()
                    .enumerate()
                    .filter(|(i, _)| *i >= start && *i < end)
                    .map(|(_, l)| l)
                    .collect::<Vec<_>>()
                    .join("\n")
            }
        };
        let view = self.get_note(&note.id)?;
        Ok(NoteText {
            id: note.id.clone(),
            path: note.path.clone(),
            title: note.title.clone(),
            collection: collection_of(&note.path),
            text,
            headings: note.meta.headings.iter().map(|h| h.text.clone()).collect(),
            links_to: view
                .outgoing
                .iter()
                .filter(|l| !l.unresolved)
                .map(|l| l.title.clone())
                .collect(),
            linked_from: view.backlinks.iter().map(|b| b.title.clone()).collect(),
        })
    }

    pub fn find_note(&self, query: &str) -> Option<String> {
        self.vault.find_note(query).map(|n| n.id.clone())
    }

    pub fn search(
        &self,
        query: &str,
        collection: Option<&str>,
        limit: usize,
    ) -> Result<Vec<SearchHit>, ApiError> {
        Ok(self.store.search(query, collection, limit.clamp(1, 100))?)
    }

    pub fn graph(&self, req: &GraphRequest) -> Result<GraphOut, ApiError> {
        let data = self.index.graph(
            &self.vault,
            GraphOptions {
                unresolved: req.unresolved,
                tags: req.tags,
                attachments: req.attachments,
                orphans: !req.hide_orphans,
            },
        );
        let collection_core: Option<BTreeSet<String>> = req.collection.as_ref().map(|c| {
            self.vault
                .notes
                .iter()
                .filter(|n| collection_of(&n.path).as_deref() == Some(c.as_str()))
                .map(|n| n.path.clone())
                .collect()
        });
        let keep: Option<BTreeSet<String>> = match (&req.focus, &collection_core) {
            (Some(id), _) => {
                let note = self.vault.note_by_id(id).ok_or(ApiError::NoteNotFound)?;
                Some(
                    self.index
                        .neighborhood(&note.path, req.depth.unwrap_or(1).clamp(1, 3)),
                )
            }
            (None, Some(core)) => {
                // The collection's notes plus anything one link away (shown dimmed).
                let mut k = core.clone();
                for p in core {
                    k.extend(self.index.neighborhood(p, 1));
                }
                Some(k)
            }
            (None, None) => None,
        };
        // In a local graph, keep an edge if its source is kept and its target is kept
        // or is a non-note node (tag / unresolved / attachment) hanging off it.
        let edge_kept = |s: &str, t: &str| match &keep {
            None => true,
            Some(k) => {
                let is_note = self.vault.note_by_path(t).is_some();
                k.contains(s) && (k.contains(t) || !is_note)
            }
        };
        let edges: Vec<(String, String, usize)> = data
            .edges
            .iter()
            .filter(|e| edge_kept(&e.source, &e.target))
            .map(|e| (e.source.clone(), e.target.clone(), e.weight))
            .collect();
        let used: BTreeSet<&str> = edges
            .iter()
            .flat_map(|(s, t, _)| [s.as_str(), t.as_str()])
            .collect();
        let nodes = data
            .nodes
            .into_iter()
            .filter(|n| match &keep {
                None => true,
                Some(k) => k.contains(&n.id) || used.contains(n.id.as_str()),
            })
            .map(|n| {
                let note = self.vault.note_by_path(&n.id);
                GraphNodeOut {
                    dim: match &collection_core {
                        Some(core) => note.is_some() && !core.contains(&n.id),
                        None => false,
                    },
                    note_id: note.map(|x| x.id.clone()),
                    collection: note.and_then(|x| collection_of(&x.path)),
                    key: n.id,
                    label: n.label,
                    kind: n.kind,
                    degree: n.degree,
                }
            })
            .collect::<Vec<GraphNodeOut>>();
        let mut nodes = nodes;
        let wanted = |k: &crate::ai_layer::Concept| match (&req.focus, &req.collection) {
            (Some(_), _) => k.notes.iter().any(|p| nodes.iter().any(|n| n.key == *p)),
            (None, Some(c)) => k.collection == *c,
            (None, None) => true,
        };
        let concepts: Vec<_> = self
            .ai
            .visible_concepts(&self.vault)
            .into_iter()
            .filter(|k| wanted(k))
            .collect();
        let mut ai_edges: Vec<(String, String, String, String)> = Vec::new();
        for k in &concepts {
            let key = format!("concept:{}", k.id);
            for p in &k.notes {
                ai_edges.push((
                    key.clone(),
                    p.clone(),
                    "concept".into(),
                    status_name(k.status).into(),
                ));
            }
            nodes.push(GraphNodeOut {
                key,
                label: k.title.clone(),
                kind: NodeKind::Concept,
                degree: k.notes.len(),
                note_id: None,
                collection: Some(k.collection.clone()),
                dim: false,
            });
        }
        let shown: BTreeSet<&str> = nodes.iter().map(|n| n.key.as_str()).collect();
        ai_edges.retain(|(_, p, _, _)| shown.contains(p.as_str()));
        let mut conn_edges: Vec<(String, String, String, String)> = self
            .ai
            .visible(&self.vault)
            .filter(|c| shown.contains(c.from.as_str()) && shown.contains(c.to.as_str()))
            .map(|c| {
                (
                    c.from.clone(),
                    c.to.clone(),
                    c.r#type.clone(),
                    status_name(c.status).into(),
                )
            })
            .collect();
        conn_edges.append(&mut ai_edges);
        Ok(GraphOut {
            nodes,
            edges,
            ai_edges: conn_edges,
        })
    }

    /// Bytes of a library file, only if it is one of the library's files (no path tricks).
    pub fn read_file(&self, vault_relative: &str) -> Option<Vec<u8>> {
        if self.vault.root.as_os_str().is_empty() {
            return None;
        }
        self.vault
            .files
            .binary_search_by(|f| f.as_str().cmp(vault_relative))
            .ok()?;
        std::fs::read(self.vault.root.join(vault_relative)).ok()
    }
}

impl Workspace {
    /// AI connections touching `path`, each with the other note named, for the note panel.
    pub fn ai_connections_for(&self, path: &str) -> Vec<serde_json::Value> {
        self.ai
            .for_note(&self.vault, path)
            .into_iter()
            .filter_map(|c| {
                let (other, direction) = if c.from == path {
                    (&c.to, "out")
                } else {
                    (&c.from, "in")
                };
                let o = self.vault.note_by_path(other)?;
                Some(serde_json::json!({
                    "id": c.id,
                    "other_id": o.id,
                    "other_title": o.title,
                    "other_path": o.path,
                    "direction": direction,
                    "type": c.r#type,
                    "reason": c.reason,
                    "evidence": c.evidence,
                    "confidence": c.confidence,
                    "status": status_name(c.status),
                    "made_by": c.made_by,
                    "created_at": c.created_at,
                }))
            })
            .collect()
    }
}

pub fn status_name(s: crate::ai_layer::Status) -> &'static str {
    match s {
        crate::ai_layer::Status::Suggested => "suggested",
        crate::ai_layer::Status::Kept => "kept",
        crate::ai_layer::Status::Dismissed => "dismissed",
    }
}

pub fn mime_for(path: &str) -> &'static str {
    match path.rsplit('.').next().map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        Some("bmp") => "image/bmp",
        // SVG can carry scripts; it is only ever loaded via <img>, which doesn't run them.
        Some("svg") => "image/svg+xml",
        Some("pdf") => "application/pdf",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws() -> (tempfile::TempDir, Workspace) {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path();
        std::fs::create_dir_all(r.join("Biology")).unwrap();
        std::fs::write(
            r.join("Biology/Plan.md"),
            "# Plan\nSee [[Notes]] #launch ![[pic.png]]",
        )
        .unwrap();
        std::fs::write(r.join("Biology/Notes.md"), "Back to [[Plan]]. [[Ghost]]").unwrap();
        std::fs::write(r.join("Biology/pic.png"), [1u8, 2, 3]).unwrap();
        std::fs::write(r.join("Lonely.md"), "alone").unwrap();
        let w = Workspace::open(r).unwrap();
        (dir, w)
    }

    #[test]
    fn note_view_has_links_both_ways() {
        let (_d, w) = ws();
        let id = w.find_note("Plan").unwrap();
        let v = w.get_note(&id).unwrap();
        assert!(v.html.contains("cerebra://note/"));
        assert_eq!(v.backlinks.len(), 1);
        assert_eq!(v.backlinks[0].title, "Notes");
        assert!(v.outgoing.iter().any(|o| o.title == "Notes"));
        let notes = w.get_note(&w.find_note("Notes").unwrap()).unwrap();
        assert!(notes.outgoing.iter().any(|o| o.unresolved && o.title == "Ghost"));
    }

    #[test]
    fn local_graph_is_limited_to_neighbourhood() {
        let (_d, w) = ws();
        let id = w.find_note("Plan").unwrap();
        let g = w
            .graph(&GraphRequest {
                focus: Some(id),
                tags: true,
                ..Default::default()
            })
            .unwrap();
        let labels: Vec<_> = g.nodes.iter().map(|n| n.label.as_str()).collect();
        assert!(labels.contains(&"Plan") && labels.contains(&"Notes") && labels.contains(&"#launch"));
        assert!(!labels.contains(&"Lonely"));
        let global = w.graph(&GraphRequest::default()).unwrap();
        assert!(global.nodes.iter().any(|n| n.label == "Lonely"));
    }

    #[test]
    fn read_file_only_serves_library_files() {
        let (_d, w) = ws();
        assert_eq!(w.read_file("Biology/pic.png"), Some(vec![1, 2, 3]));
        assert_eq!(w.read_file("../etc/passwd"), None);
        assert_eq!(w.read_file("Biology/../../outside"), None);
    }

    #[test]
    fn note_view_points_at_uploaded_original() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join("Biology")).unwrap();
        let up = crate::upload::save_upload(d.path(), "Biology", "unit3.pdf", b"%PDF").unwrap();
        let w = Workspace::open(d.path()).unwrap();
        let v = w.get_note(&w.find_note("unit3").unwrap()).unwrap();
        assert_eq!(v.source_file, up.attachment_path);
        assert!(v.text.starts_with("---\nsource: Files/unit3.pdf"));
    }
}
