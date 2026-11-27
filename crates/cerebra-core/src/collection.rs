//! Collections: every top-level folder of a library is one (a subject, a course, a project).
//! Notes at the library root belong to no collection (the UI calls them "Inbox").

use std::collections::BTreeMap;

use crate::vault::Vault;

/// The collection a library-relative path belongs to: its first folder, exactly as written.
/// `None` for files at the library root.
pub fn collection_of(path: &str) -> Option<String> {
    let (first, rest) = path.split_once('/')?;
    (!first.is_empty() && !rest.is_empty()).then(|| first.to_string())
}

/// Every collection with its number of notes, sorted by name. Root notes aren't listed.
pub fn collections(vault: &Vault) -> Vec<(String, usize)> {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for n in &vault.notes {
        if let Some(c) = collection_of(&n.path) {
            *counts.entry(c).or_default() += 1;
        }
    }
    counts.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collection_names_kept_verbatim() {
        assert_eq!(
            collection_of("Work - Project X/a.md").as_deref(),
            Some("Work - Project X")
        );
        assert_eq!(collection_of("Física/Óptica/b.md").as_deref(), Some("Física"));
    }

    #[test]
    fn root_files_have_no_collection() {
        assert_eq!(collection_of("Quick.md"), None);
    }

    #[test]
    fn collections_counts_notes_sorted() {
        let v = Vault::from_notes([
            ("Physics/c.md", "y"),
            ("Biology/a.md", "x"),
            ("Biology/Sub/b.md", "x"),
            ("Quick.md", "z"),
        ]);
        assert_eq!(
            collections(&v),
            vec![("Biology".to_string(), 2), ("Physics".to_string(), 1)]
        );
    }
}
