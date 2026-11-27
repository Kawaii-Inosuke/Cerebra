//! Loads a vault folder: every file's vault-relative path, plus parsed markdown notes.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use walkdir::WalkDir;

use crate::model::NoteMeta;
use crate::parse::parse;

/// Folders that are never part of the knowledge base.
const IGNORED_DIRS: &[&str] = &[".obsidian", ".trash", ".cerebra", ".git", "node_modules"];

#[derive(Debug, Clone)]
pub struct Note {
    /// Stable id derived from the vault path (`n_` + 12 hex chars).
    pub id: String,
    /// Vault-relative path with `/` separators, e.g. `Biology/Cell Structure.md`.
    pub path: String,
    /// File name without `.md`.
    pub title: String,
    pub text: String,
    /// `sha256:<hex>` of the file content.
    pub hash: String,
    pub meta: NoteMeta,
}

#[derive(Debug, Clone, Default)]
pub struct Vault {
    pub root: PathBuf,
    pub notes: Vec<Note>,
    /// Every file in the vault (notes and attachments), vault-relative, sorted.
    pub files: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("vault folder not found: {0}")]
    NotFound(PathBuf),
    #[error("io error at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

impl Vault {
    /// Walk `root` and parse every `.md` file.
    pub fn load(root: impl AsRef<Path>) -> Result<Vault, VaultError> {
        let root = root.as_ref().to_path_buf();
        if !root.is_dir() {
            return Err(VaultError::NotFound(root));
        }
        let mut entries: Vec<(String, Option<String>)> = Vec::new();
        let walker = WalkDir::new(&root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| {
                e.depth() == 0
                    || !is_ignored(e.file_name().to_string_lossy().as_ref(), e.file_type().is_dir())
            });
        // Folders or files that can't be read (permissions, broken links) are skipped, so one
        // locked subfolder never stops the whole library from opening.
        for entry in walker {
            let Ok(entry) = entry else { continue };
            if !entry.file_type().is_file() {
                continue;
            }
            let rel = rel_path(&root, entry.path());
            if is_markdown(&rel) {
                let Ok(text) = std::fs::read(entry.path()) else {
                    continue;
                };
                // Notes with invalid UTF-8 are still indexed (lossily) rather than dropped.
                entries.push((rel, Some(String::from_utf8_lossy(&text).into_owned())));
            } else {
                entries.push((rel, None));
            }
        }
        let mut v = Vault::from_entries(entries);
        v.root = root;
        Ok(v)
    }

    /// Build a vault from in-memory `(path, content)` pairs. `None` content = attachment.
    pub fn from_entries(entries: impl IntoIterator<Item = (String, Option<String>)>) -> Vault {
        let mut notes = Vec::new();
        let mut files = Vec::new();
        for (path, content) in entries {
            if let Some(text) = content.filter(|_| is_markdown(&path)) {
                notes.push(Note {
                    id: note_id(&path),
                    title: title_of(&path),
                    hash: content_hash(text.as_bytes()),
                    meta: parse(&text),
                    path: path.clone(),
                    text,
                });
            }
            files.push(path);
        }
        files.sort();
        notes.sort_by(|a, b| a.path.cmp(&b.path));
        Vault {
            root: PathBuf::new(),
            notes,
            files,
        }
    }

    /// Convenience for tests: every entry is a markdown note.
    pub fn from_notes<'a>(notes: impl IntoIterator<Item = (&'a str, &'a str)>) -> Vault {
        Vault::from_entries(
            notes
                .into_iter()
                .map(|(p, t)| (p.to_string(), Some(t.to_string()))),
        )
    }

    pub fn note_by_path(&self, path: &str) -> Option<&Note> {
        self.notes
            .binary_search_by(|n| n.path.as_str().cmp(path))
            .ok()
            .map(|i| &self.notes[i])
    }

    pub fn note_by_id(&self, id: &str) -> Option<&Note> {
        self.notes.iter().find(|n| n.id == id)
    }

    /// Find a note by exact path, id, title, then alias (titles/aliases case-insensitive).
    pub fn find_note(&self, query: &str) -> Option<&Note> {
        let q = query.trim_end_matches(".md").to_lowercase();
        self.note_by_path(query)
            .or_else(|| self.note_by_id(query))
            .or_else(|| self.notes.iter().find(|n| n.title.to_lowercase() == q))
            .or_else(|| {
                self.notes
                    .iter()
                    .find(|n| n.meta.aliases.iter().any(|a| a.to_lowercase() == q))
            })
    }
}

fn is_ignored(name: &str, is_dir: bool) -> bool {
    is_dir && is_ignored_dir(name)
}

/// Folders the library never reads (hidden folders, `node_modules`, …).
pub fn is_ignored_dir(name: &str) -> bool {
    name.starts_with('.') || IGNORED_DIRS.contains(&name)
}

pub fn is_markdown(path: &str) -> bool {
    path.to_lowercase().ends_with(".md")
}

fn rel_path(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .unwrap_or(p)
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

pub fn title_of(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    match name.len().checked_sub(3) {
        Some(i) if name.to_lowercase().ends_with(".md") => name[..i].to_string(),
        _ => name.to_string(),
    }
}

pub fn note_id(path: &str) -> String {
    let h = Sha256::digest(path.as_bytes());
    format!("n_{}", &hex::encode(h)[..12])
}

pub fn content_hash(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_folder_and_skips_hidden() {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path();
        std::fs::create_dir_all(r.join("A/B")).unwrap();
        std::fs::create_dir_all(r.join(".obsidian")).unwrap();
        std::fs::write(r.join("A/B/Note.md"), "[[Other]]").unwrap();
        std::fs::write(r.join("Other.MD"), "hi").unwrap();
        std::fs::write(r.join("A/pic.png"), [0u8, 1, 2]).unwrap();
        std::fs::write(r.join(".obsidian/app.json"), "{}").unwrap();
        let v = Vault::load(r).unwrap();
        assert_eq!(v.files, vec!["A/B/Note.md", "A/pic.png", "Other.MD"]);
        assert_eq!(v.notes.len(), 2);
        assert_eq!(v.find_note("other").unwrap().path, "Other.MD");
        assert_eq!(
            v.note_by_path("A/B/Note.md").unwrap().meta.links[0].target,
            "Other"
        );
    }

    #[test]
    fn library_skips_cerebra_and_obsidian_folders() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        std::fs::create_dir_all(r.join(".cerebra")).unwrap();
        std::fs::create_dir_all(r.join(".obsidian")).unwrap();
        std::fs::write(r.join(".cerebra/x.md"), "hidden").unwrap();
        std::fs::write(r.join(".obsidian/y.md"), "hidden").unwrap();
        std::fs::write(r.join("Real.md"), "[[Other]]").unwrap();
        let v = Vault::load(r).unwrap();
        let paths: Vec<_> = v.notes.iter().map(|n| n.path.clone()).collect();
        assert_eq!(paths, vec!["Real.md".to_string()]);
    }

    #[test]
    fn ids_are_stable() {
        assert_eq!(note_id("a.md"), note_id("a.md"));
        assert_ne!(note_id("a.md"), note_id("b.md"));
        assert_eq!(title_of("x/My Note.md"), "My Note");
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_folders_and_files_are_skipped() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        std::fs::create_dir_all(r.join("Locked")).unwrap();
        std::fs::write(r.join("Locked/secret.md"), "x").unwrap();
        std::fs::write(r.join("Private.md"), "y").unwrap();
        std::fs::write(r.join("Fine.md"), "ok").unwrap();
        std::fs::set_permissions(r.join("Locked"), std::fs::Permissions::from_mode(0o000)).unwrap();
        std::fs::set_permissions(r.join("Private.md"), std::fs::Permissions::from_mode(0o000)).unwrap();
        let v = Vault::load(r);
        std::fs::set_permissions(r.join("Locked"), std::fs::Permissions::from_mode(0o755)).unwrap();
        let v = v.unwrap();
        assert!(v.notes.iter().any(|n| n.path == "Fine.md"));
        assert!(!v.notes.iter().any(|n| n.path == "Locked/secret.md"));
        assert!(!v.notes.iter().any(|n| n.path == "Private.md"));
    }
}
