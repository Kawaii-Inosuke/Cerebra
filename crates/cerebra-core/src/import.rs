//! Import an existing Obsidian vault (or one folder of it) as a new collection, so notes
//! someone already linked up don't have to be rebuilt in Cerebra.
//!
//! Files are **copied** into `<collection>/` at the library root, as they are: the `[[links]]`
//! keep working because Cerebra resolves links like Obsidian. The source folder is only read.
//! The collection must not exist yet, so nothing is ever overwritten or merged. Afterwards the
//! report lists links that point outside what was imported.

use std::path::{Path, PathBuf};

use serde::Serialize;
use walkdir::WalkDir;

use crate::graph::LinkIndex;
use crate::vault::{Vault, is_markdown};

const SKIP_DIRS: &[&str] = &[".obsidian", ".trash", ".git", "node_modules", ".cerebra"];
const MAX_FILES: usize = 20_000;
const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Default, Serialize)]
pub struct ImportReport {
    pub collection: String,
    pub notes: usize,
    pub files: usize,
    /// Too big, or a link/shortcut instead of a real file.
    pub skipped: Vec<String>,
    /// Link targets inside the imported notes that don't resolve to any note (up to 50).
    pub missing_links: Vec<String>,
    pub missing_link_count: usize,
}

#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    #[error("That folder doesn't exist or can't be read")]
    NoSource,
    #[error("Choose a folder outside this library")]
    InsideLibrary,
    #[error("That collection name can't be used")]
    BadName,
    #[error("A collection called \"{0}\" already exists; choose another name")]
    Exists(String),
    #[error("The folder has more than {MAX_FILES} files; import a smaller folder")]
    TooMany,
    #[error("The folder is larger than 2 GB; import a smaller folder")]
    TooBig,
    #[error("No notes (.md files) in that folder")]
    NoNotes,
    #[error("Couldn't copy: {0}")]
    Io(#[from] std::io::Error),
}

fn clean_name(name: &str) -> Option<String> {
    let n: String = name
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect();
    let n = n.trim().trim_start_matches('.').trim().to_string();
    (!n.is_empty() && n.len() <= 80).then_some(n)
}

/// Copy `source` into a new collection `<library_root>/<collection_name>/`.
pub fn import_folder(
    library_root: &Path,
    source: &Path,
    collection_name: &str,
) -> Result<ImportReport, ImportError> {
    let source = source.canonicalize().map_err(|_| ImportError::NoSource)?;
    if !source.is_dir() {
        return Err(ImportError::NoSource);
    }
    let root = library_root.canonicalize().map_err(|_| ImportError::NoSource)?;
    if source.starts_with(&root) || root.starts_with(&source) {
        return Err(ImportError::InsideLibrary);
    }
    let name = clean_name(collection_name).ok_or(ImportError::BadName)?;
    let dest = root.join(&name);
    if dest.exists() {
        return Err(ImportError::Exists(name));
    }

    // Plan first (so nothing is half-copied when a limit is hit).
    let mut plan: Vec<(PathBuf, PathBuf, String)> = Vec::new();
    let mut total = 0u64;
    let mut report = ImportReport {
        collection: name.clone(),
        ..Default::default()
    };
    let walker = WalkDir::new(&source)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            e.depth() == 0
                || !(e.file_type().is_dir()
                    && (e.file_name().to_string_lossy().starts_with('.')
                        || SKIP_DIRS.contains(&e.file_name().to_string_lossy().as_ref())))
        });
    for entry in walker.flatten() {
        let ft = entry.file_type();
        if ft.is_dir() {
            continue;
        }
        let rel = entry.path().strip_prefix(&source).unwrap_or(entry.path());
        let rel_s = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
        if !ft.is_file() {
            report.skipped.push(format!("{rel_s} (a link, not a file)"));
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        if size > MAX_FILE_BYTES {
            report.skipped.push(format!("{rel_s} (over 100 MB)"));
            continue;
        }
        total += size;
        if total > MAX_TOTAL_BYTES {
            return Err(ImportError::TooBig);
        }
        plan.push((entry.path().to_path_buf(), dest.join(rel), rel_s));
        if plan.len() > MAX_FILES {
            return Err(ImportError::TooMany);
        }
    }
    if !plan.iter().any(|(_, _, r)| is_markdown(r)) {
        return Err(ImportError::NoNotes);
    }

    let mut imported: Vec<String> = Vec::new();
    for (from, to, rel) in plan {
        if let Some(dir) = to.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::copy(&from, &to)?;
        if is_markdown(&rel) {
            report.notes += 1;
            imported.push(format!("{name}/{rel}"));
        } else {
            report.files += 1;
        }
    }

    // Links from the imported notes that don't resolve anywhere in the library.
    if let Ok(vault) = Vault::load(&root) {
        let idx = LinkIndex::build(&vault);
        let mut missing: Vec<String> = imported
            .iter()
            .filter_map(|p| idx.unresolved.get(p))
            .flat_map(|m| m.keys().cloned())
            .collect();
        missing.sort();
        missing.dedup();
        report.missing_link_count = missing.len();
        report.missing_links = missing.into_iter().take(50).collect();
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn their_vault(d: &Path) -> PathBuf {
        let src = d.join("their-vault");
        std::fs::create_dir_all(src.join(".obsidian")).unwrap();
        std::fs::create_dir_all(src.join("Lectures")).unwrap();
        std::fs::write(src.join(".obsidian/app.json"), "{}").unwrap();
        std::fs::write(src.join("Hub.md"), "[[Week 1]] [[Elsewhere]] ![[diagram.png]]").unwrap();
        std::fs::write(src.join("Lectures/Week 1.md"), "Back to [[Hub]]").unwrap();
        std::fs::write(src.join("diagram.png"), [1u8, 2, 3]).unwrap();
        src
    }

    #[test]
    fn copies_a_vault_as_a_new_collection_keeping_links() {
        let d = tempfile::tempdir().unwrap();
        let src = their_vault(d.path());
        let lib = d.path().join("library");
        std::fs::create_dir_all(&lib).unwrap();

        let r = import_folder(&lib, &src, "Chemistry").unwrap();
        assert_eq!(r.collection, "Chemistry");
        assert_eq!((r.notes, r.files), (2, 1));
        assert!(lib.join("Chemistry/Lectures/Week 1.md").exists());
        assert!(!lib.join("Chemistry/.obsidian").exists());
        assert!(src.join("Hub.md").exists(), "the source is only read");
        assert_eq!(r.missing_links, vec!["Elsewhere".to_string()]);
    }

    #[test]
    fn import_refuses_existing_collection() {
        let d = tempfile::tempdir().unwrap();
        let src = their_vault(d.path());
        let lib = d.path().join("library");
        std::fs::create_dir_all(lib.join("Biology")).unwrap();
        std::fs::write(lib.join("Biology/a.md"), "ours").unwrap();
        assert!(matches!(
            import_folder(&lib, &src, "Biology"),
            Err(ImportError::Exists(_))
        ));
        assert_eq!(std::fs::read_to_string(lib.join("Biology/a.md")).unwrap(), "ours");
        assert!(!lib.join("Biology/Hub.md").exists(), "nothing written");
    }

    #[test]
    fn refuses_folders_inside_the_library_and_bad_names() {
        let d = tempfile::tempdir().unwrap();
        let src = their_vault(d.path());
        let lib = d.path().join("library");
        std::fs::create_dir_all(lib.join("Inner")).unwrap();
        std::fs::write(lib.join("Inner/n.md"), "x").unwrap();
        assert!(matches!(
            import_folder(&lib, &lib.join("Inner"), "X"),
            Err(ImportError::InsideLibrary)
        ));
        assert!(matches!(
            import_folder(&lib, &src, "   "),
            Err(ImportError::BadName)
        ));
        let r = import_folder(&lib, &src, "../escape").unwrap();
        assert_eq!(r.collection, "escape", "slashes and leading dots are removed");
        assert!(!d.path().join("escape").exists(), "never outside the library");
    }
}
