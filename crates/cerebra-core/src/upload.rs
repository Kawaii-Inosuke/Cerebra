//! Uploads (docs/02-TRD.md R4–R5).
//!
//! Originals go into `<collection>/Files/`; a Markdown note made for each one sits next to
//! them in `<collection>/` with `source: Files/<file>` in its frontmatter, embeds the original,
//! and holds the text copied out of it (`extract.rs`, with OCR for scans) so it can be
//! searched and connected. Markdown and text uploads become notes directly. Cerebra only ever
//! creates new files here; it never edits the user's own notes.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::collection::collection_of;
use crate::graph::LinkIndex;
use crate::mask::mask;
use crate::time::now_iso;
use crate::vault::{Vault, title_of};

pub const MAX_UPLOAD_BYTES: usize = 25 * 1024 * 1024;
/// Folder inside a collection where originals are kept.
pub const FILES_DIR: &str = "Files";

#[derive(Debug, thiserror::Error)]
pub enum UploadError {
    #[error("{0} is larger than 25 MB")]
    TooLarge(String),
    #[error("That file name can't be used")]
    BadName,
    #[error("Collection not found: {0}")]
    NoCollection(String),
    #[error("Couldn't save the file: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Serialize)]
pub struct UploadResult {
    /// Library path of the note created for this upload.
    pub note_path: String,
    /// Library path of the stored original, if it isn't itself the note.
    pub attachment_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Suggestion {
    pub target_path: String,
    pub title: String,
    /// The words in the upload that matched (title or alias).
    pub matched: String,
    pub line: usize,
}

/// Keep a file name safe: no folders, no control characters, no leading dots.
pub fn sanitize_name(name: &str) -> Option<String> {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|' | '#' | '^' | '[' | ']')
        })
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').trim().to_string();
    (!cleaned.is_empty() && cleaned != "..").then_some(cleaned)
}

fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let p = dir.join(name);
    if !p.exists() {
        return p;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (2..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .expect("some free name")
}

/// Save one uploaded file into `collection` (a top-level folder of the library that exists).
pub fn save_upload(
    library_root: &Path,
    collection: &str,
    file_name: &str,
    bytes: &[u8],
) -> Result<UploadResult, UploadError> {
    if bytes.len() > MAX_UPLOAD_BYTES {
        return Err(UploadError::TooLarge(file_name.into()));
    }
    // Exactly one plain folder name (no drive letters, roots or separators on any OS),
    // not a folder the library ignores, and it must exist.
    let one_plain_name = {
        let mut parts = Path::new(collection).components();
        matches!(parts.next(), Some(std::path::Component::Normal(_))) && parts.next().is_none()
    };
    let valid = one_plain_name
        && !collection.contains(['/', '\\', ':'])
        && !crate::vault::is_ignored_dir(collection)
        && library_root.join(collection).is_dir();
    if !valid {
        return Err(UploadError::NoCollection(collection.into()));
    }
    let name = sanitize_name(file_name).ok_or(UploadError::BadName)?;
    let dir = library_root.join(collection);
    let rel = |sub: &str, p: &Path| {
        let file = p.file_name().unwrap().to_string_lossy();
        if sub.is_empty() {
            format!("{collection}/{file}")
        } else {
            format!("{collection}/{sub}/{file}")
        }
    };
    let lower = name.to_lowercase();

    if lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".txt") {
        let text = String::from_utf8_lossy(bytes);
        let path = unique_path(&dir, &format!("{}.md", stem(&name)));
        let body = if text.trim_start().starts_with("---") {
            text.to_string()
        } else {
            format!("---\nuploaded: {}\n---\n{text}", now_iso())
        };
        std::fs::write(&path, format!("{}\n", body.trim_end()))?;
        return Ok(UploadResult {
            note_path: rel("", &path),
            attachment_path: None,
        });
    }

    let files = dir.join(FILES_DIR);
    std::fs::create_dir_all(&files)?;
    let file_path = unique_path(&files, &name);
    std::fs::write(&file_path, bytes)?;
    let stored = file_path.file_name().unwrap().to_string_lossy().into_owned();
    let note_path = unique_path(&dir, &format!("{}.md", stem(&stored)));
    let body = match crate::extract::extract(&name, bytes) {
        Some(parts) => format!(
            "\n## Text from the file\n\nCopied from the file when it was uploaded, so search and AI can read it.\n{}",
            crate::extract::to_markdown(&parts)
        ),
        None => {
            "\nUploaded file. Cerebra found no text it can read in it, so search and AI only see its name. \
                 (Cerebra reads text from PDF, Word .docx, PowerPoint .pptx and pictures.)\n"
                .to_string()
        }
    };
    let note = format!(
        "---\nsource: {FILES_DIR}/{stored}\nuploaded: {}\n---\n# {}\n\n![[{collection}/{FILES_DIR}/{stored}]]\n{body}",
        now_iso(),
        stem(&stored)
    );
    std::fs::write(&note_path, note)?;
    Ok(UploadResult {
        note_path: rel("", &note_path),
        attachment_path: Some(rel(FILES_DIR, &file_path)),
    })
}

fn stem(name: &str) -> &str {
    match name.rfind('.') {
        Some(i) if i > 0 => &name[..i],
        _ => name,
    }
}

/// Existing notes (same collection, or at the library root) whose title or alias is mentioned in the
/// note at `path` but not linked yet. Case-insensitive, whole words, outside code.
pub fn mention_suggestions(vault: &Vault, path: &str) -> Vec<Suggestion> {
    let Some(note) = vault.note_by_path(path) else {
        return Vec::new();
    };
    let collection = collection_of(path);
    let idx = LinkIndex::build(vault);
    let already: Vec<&str> = idx
        .resolved
        .get(path)
        .map(|m| m.keys().map(String::as_str).collect())
        .unwrap_or_default();
    let masked = mask(&note.text).to_lowercase();
    let body_start = note.meta.body_start;
    let mut out: Vec<Suggestion> = Vec::new();
    for other in &vault.notes {
        if other.path == path || already.contains(&other.path.as_str()) {
            continue;
        }
        let oc = collection_of(&other.path);
        if oc.is_some() && oc != collection {
            continue;
        }
        let names = std::iter::once(other.title.clone()).chain(other.meta.aliases.iter().cloned());
        for name in names {
            if name.chars().count() < 4 {
                continue;
            }
            if let Some(pos) = find_word(&masked[body_start.min(masked.len())..], &name.to_lowercase()) {
                let at = body_start + pos;
                out.push(Suggestion {
                    target_path: other.path.clone(),
                    title: other.title.clone(),
                    matched: name.clone(),
                    line: masked[..at].matches('\n').count(),
                });
                break;
            }
        }
    }
    out.sort_by(|a, b| a.title.cmp(&b.title));
    out
}

fn find_word(hay: &str, needle: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(rel) = hay[from..].find(needle) {
        let start = from + rel;
        let end = start + needle.len();
        let before = hay[..start].chars().next_back();
        let after = hay[end..].chars().next();
        let boundary = |c: Option<char>| c.is_none_or(|c| !c.is_alphanumeric());
        if boundary(before) && boundary(after) {
            return Some(start);
        }
        from = start + needle.len().max(1);
        if from >= hay.len() {
            break;
        }
        while !hay.is_char_boundary(from) {
            from += 1;
        }
    }
    None
}

pub fn title_for(path: &str) -> String {
    title_of(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join("Biology")).unwrap();
        std::fs::create_dir_all(d.path().join("Physics")).unwrap();
        std::fs::create_dir_all(d.path().join("Física")).unwrap();
        std::fs::create_dir_all(d.path().join("node_modules")).unwrap();
        std::fs::write(
            d.path().join("Biology/Exam Plan.md"),
            "---\naliases: [Mid-term]\n---\nplan",
        )
        .unwrap();
        std::fs::write(d.path().join("Physics/Secret Topic.md"), "x").unwrap();
        d
    }

    fn read(d: &tempfile::TempDir, rel: &str) -> String {
        std::fs::read_to_string(d.path().join(rel)).unwrap()
    }

    #[test]
    fn sanitizes_names() {
        assert_eq!(sanitize_name("../../etc/passwd").as_deref(), Some("passwd"));
        assert_eq!(sanitize_name("C:\\x\\Report.pdf").as_deref(), Some("Report.pdf"));
        assert_eq!(sanitize_name("..").as_deref(), None);
        assert_eq!(sanitize_name(".hidden").as_deref(), Some("hidden"));
        assert_eq!(sanitize_name("a[[b]]|c#d.md").as_deref(), Some("abcd.md"));
    }

    #[test]
    fn markdown_upload_becomes_note_in_collection() {
        let d = setup();
        let r = save_upload(
            d.path(),
            "Biology",
            "Brief.md",
            b"# Brief\nThe mid-term slips. Secret Topic too.",
        )
        .unwrap();
        assert_eq!(r.note_path, "Biology/Brief.md");
        assert_eq!(r.attachment_path, None);
        let v = Vault::load(d.path()).unwrap();
        let s = mention_suggestions(&v, &r.note_path);
        // "Mid-term" is an alias of Exam Plan; "Secret Topic" is in another collection.
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].title, "Exam Plan");
        assert_eq!(s[0].matched, "Mid-term");
    }

    #[test]
    fn note_frontmatter_points_at_original() {
        let d = setup();
        let r = save_upload(d.path(), "Biology", "unit3.pdf", b"%PDF").unwrap();
        assert_eq!(r.attachment_path.as_deref(), Some("Biology/Files/unit3.pdf"));
        assert_eq!(r.note_path, "Biology/unit3.md");
        let note = read(&d, &r.note_path);
        assert!(
            note.starts_with("---\nsource: Files/unit3.pdf\nuploaded: "),
            "{note}"
        );
        assert!(note.contains("![[Biology/Files/unit3.pdf]]"), "{note}");
        assert!(note.contains("Cerebra"), "explains missing text: {note}");
    }

    #[test]
    fn second_upload_same_name_gets_numbered() {
        let d = setup();
        let a = save_upload(d.path(), "Biology", "unit3.pdf", b"%PDF-one").unwrap();
        let b = save_upload(d.path(), "Biology", "unit3.pdf", b"%PDF-two").unwrap();
        assert_eq!(a.attachment_path.as_deref(), Some("Biology/Files/unit3.pdf"));
        assert_eq!(b.attachment_path.as_deref(), Some("Biology/Files/unit3 (2).pdf"));
        assert_eq!(a.note_path, "Biology/unit3.md");
        assert_eq!(b.note_path, "Biology/unit3 (2).md");
        assert_eq!(
            std::fs::read(d.path().join("Biology/Files/unit3.pdf")).unwrap(),
            b"%PDF-one"
        );
        assert!(read(&d, &b.note_path).contains("![[Biology/Files/unit3 (2).pdf]]"));
    }

    #[test]
    fn upload_into_unicode_collection() {
        let d = setup();
        let r = save_upload(d.path(), "Física", "notas.txt", b"Luz").unwrap();
        assert_eq!(r.note_path, "Física/notas.md");
        assert!(read(&d, &r.note_path).contains("Luz"));
    }

    #[test]
    fn same_file_name_in_two_collections_embeds_its_own_original() {
        let d = setup();
        save_upload(d.path(), "Física", "Syllabus.pdf", b"%PDF-f").unwrap();
        let w = save_upload(d.path(), "Physics", "Syllabus.pdf", b"%PDF-p").unwrap();
        let v = Vault::load(d.path()).unwrap();
        let idx = LinkIndex::build(&v);
        let targets: Vec<_> = idx.outgoing(&w.note_path).filter_map(|e| e.dst.clone()).collect();
        assert_eq!(targets, vec!["Physics/Files/Syllabus.pdf".to_string()]);
    }

    #[test]
    fn rejects_bad_targets() {
        let d = setup();
        for bad in [
            "Nope",
            "../..",
            "Biology/Sub",
            "",
            "Biology/../Physics",
            "C:",
            "/tmp",
            "Bio:logy",
            "node_modules",
        ] {
            assert!(
                matches!(
                    save_upload(d.path(), bad, "a.md", b"x"),
                    Err(UploadError::NoCollection(_))
                ),
                "{bad}"
            );
        }
        let big = vec![0u8; MAX_UPLOAD_BYTES + 1];
        assert!(matches!(
            save_upload(d.path(), "Biology", "a.bin", &big),
            Err(UploadError::TooLarge(_))
        ));
    }
}
