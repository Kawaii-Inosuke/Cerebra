//! `.cerebra` share files (docs/09-SHARE-FILES.md): one collection's notes, original files
//! and AI connections in a zip, optionally encrypted with a password (age, scrypt). Nothing
//! about the sender travels with it: no keys, index, settings, usage or absolute paths.

use std::collections::HashMap;
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::ai_layer::{AiLayer, Concept, Connection, Evidence, MadeBy, Status};
use crate::collection::collection_of;
use crate::vault::{Vault, is_markdown};

pub const FORMAT_VERSION: u32 = 1;
const MAX_TOTAL: u64 = 500 * 1024 * 1024;
const MAX_ENTRIES: usize = 10_000;
const FILE_TYPES: &[&str] = &["pdf", "docx", "pptx", "txt", "png", "jpg", "jpeg", "webp", "gif"];
const AGE_MAGIC: &[u8] = b"age-encryption.org/v1";

#[derive(Debug, Clone, Default)]
pub struct ExportOptions {
    pub include_files: bool,
    /// Also suggested AI connections (otherwise only kept ones).
    pub include_suggested: bool,
    pub password: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Counts {
    pub notes: usize,
    pub files: usize,
    pub connections: usize,
    pub concepts: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FileEntry {
    path: String,
    sha256: String,
    size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Manifest {
    format: String,
    format_version: u32,
    #[serde(default)]
    app_version: String,
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    counts: Counts,
    #[serde(default)]
    files: Vec<FileEntry>,
}

/// What a share file holds, shown before importing it.
#[derive(Debug, Clone, Serialize)]
pub struct Preview {
    pub title: String,
    pub description: String,
    pub created_at: String,
    pub counts: Counts,
    pub notes: Vec<String>,
    pub encrypted: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ShareImport {
    pub collection: String,
    pub notes: usize,
    pub files: usize,
    pub connections: usize,
    pub concepts: usize,
}

/// The share file's own copy of AI connections and concepts (paths inside the collection).
#[derive(Debug, Default, Serialize, Deserialize)]
struct SharedLayer {
    connections: Vec<Connection>,
    concepts: Vec<Concept>,
}

fn strip(path: &str, collection: &str) -> Option<String> {
    path.strip_prefix(collection)?.strip_prefix('/').map(String::from)
}

fn anonymous(m: &MadeBy) -> MadeBy {
    MadeBy {
        kind: m.kind.clone(),
        source: m
            .source
            .as_ref()
            .map(|s| s.split(':').next().unwrap_or("").to_string()),
        job: None,
    }
}

fn sha(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Pack one collection into a `.cerebra` file.
pub fn export_collection(
    vault: &Vault,
    ai: &AiLayer,
    collection: &str,
    opts: &ExportOptions,
) -> Result<Vec<u8>, String> {
    let notes: Vec<_> = vault
        .notes
        .iter()
        .filter(|n| collection_of(&n.path).as_deref() == Some(collection))
        .collect();
    if notes.is_empty() {
        return Err(format!("The collection \"{collection}\" has no notes to share"));
    }
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    for n in &notes {
        entries.push((
            format!("notes/{}", strip(&n.path, collection).unwrap()),
            n.text.clone().into_bytes(),
        ));
    }
    let mut files = 0;
    if opts.include_files {
        for f in vault
            .files
            .iter()
            .filter(|f| !is_markdown(f) && collection_of(f).as_deref() == Some(collection))
        {
            let ext = f.rsplit('.').next().unwrap_or("").to_lowercase();
            if !FILE_TYPES.contains(&ext.as_str()) {
                continue;
            }
            let bytes = std::fs::read(vault.root.join(f)).map_err(|e| format!("Couldn't read {f}: {e}"))?;
            entries.push((format!("files/{}", strip(f, collection).unwrap()), bytes));
            files += 1;
        }
    }
    let wanted = |s: Status| s == Status::Kept || (opts.include_suggested && s == Status::Suggested);
    let inside = |p: &str| collection_of(p).as_deref() == Some(collection);
    let shared = SharedLayer {
        connections: ai
            .visible(vault)
            .filter(|c| wanted(c.status) && inside(&c.from) && inside(&c.to))
            .map(|c| Connection {
                from: strip(&c.from, collection).unwrap(),
                to: strip(&c.to, collection).unwrap(),
                evidence: c
                    .evidence
                    .iter()
                    .map(|e| Evidence {
                        note: strip(&e.note, collection).unwrap_or_default(),
                        quote: e.quote.clone(),
                    })
                    .collect(),
                made_by: anonymous(&c.made_by),
                ..c.clone()
            })
            .collect(),
        concepts: ai
            .visible_concepts(vault)
            .into_iter()
            .filter(|k| wanted(k.status) && k.collection == collection && k.notes.iter().all(|p| inside(p)))
            .map(|k| Concept {
                notes: k.notes.iter().filter_map(|p| strip(p, collection)).collect(),
                made_by: anonymous(&k.made_by),
                ..k
            })
            .collect(),
    };
    let counts = Counts {
        notes: notes.len(),
        files,
        connections: shared.connections.len(),
        concepts: shared.concepts.len(),
    };
    entries.push((
        "ai-layer.json".into(),
        serde_json::to_vec_pretty(&shared).unwrap(),
    ));
    let manifest = Manifest {
        format: "cerebra".into(),
        format_version: FORMAT_VERSION,
        app_version: env!("CARGO_PKG_VERSION").into(),
        title: collection.into(),
        description: String::new(),
        created_at: crate::time::now_iso(),
        counts,
        files: entries
            .iter()
            .map(|(p, b)| FileEntry {
                path: p.clone(),
                sha256: sha(b),
                size: b.len() as u64,
            })
            .collect(),
    };

    let mut buf = Cursor::new(Vec::new());
    {
        let mut z = zip::ZipWriter::new(&mut buf);
        let o = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        z.start_file("manifest.json", o).map_err(|e| e.to_string())?;
        z.write_all(&serde_json::to_vec_pretty(&manifest).unwrap())
            .map_err(|e| e.to_string())?;
        for (p, b) in &entries {
            z.start_file(p.as_str(), o).map_err(|e| e.to_string())?;
            z.write_all(b).map_err(|e| e.to_string())?;
        }
        z.finish().map_err(|e| e.to_string())?;
    }
    let zipped = buf.into_inner();
    match opts.password.as_deref().filter(|p| !p.is_empty()) {
        None => Ok(zipped),
        Some(pw) => {
            let enc = age::Encryptor::with_user_passphrase(age::secrecy::SecretString::from(pw.to_owned()));
            let mut out = Vec::new();
            let mut w = enc.wrap_output(&mut out).map_err(|e| e.to_string())?;
            w.write_all(&zipped).map_err(|e| e.to_string())?;
            w.finish().map_err(|e| e.to_string())?;
            Ok(out)
        }
    }
}

/// A checked entry path inside the archive (`notes/…` or `files/…`), or `None` if unsafe.
fn safe_entry(name: &str) -> Option<(&'static str, String)> {
    let (kind, rel) = match name.strip_prefix("notes/") {
        Some(r) => ("notes", r),
        None => ("files", name.strip_prefix("files/")?),
    };
    if rel.is_empty() || rel.contains(['\\', ':']) || rel.starts_with('/') {
        return None;
    }
    let ok = Path::new(rel)
        .components()
        .all(|c| matches!(c, Component::Normal(n) if !n.to_string_lossy().starts_with('.')));
    let ext = rel.rsplit('.').next().unwrap_or("").to_lowercase();
    let type_ok = if kind == "notes" {
        ext == "md"
    } else {
        FILE_TYPES.contains(&ext.as_str())
    };
    (ok && type_ok).then(|| (kind, rel.to_string()))
}

struct Unpacked {
    manifest: Manifest,
    /// (notes|files, path inside the collection, bytes)
    entries: Vec<(&'static str, String, Vec<u8>)>,
    layer: SharedLayer,
    encrypted: bool,
}

fn unpack(bytes: &[u8], password: Option<&str>) -> Result<Unpacked, String> {
    unpack_limited(bytes, password, MAX_TOTAL)
}

/// Unpack, never holding more than `limit` bytes of content (zip bombs, huge encrypted files).
fn unpack_limited(bytes: &[u8], password: Option<&str>, limit: u64) -> Result<Unpacked, String> {
    let too_big = || format!("This file is larger than {} MB", limit / (1024 * 1024));
    let not_ours = "This isn't a Cerebra file, or it is damaged".to_string();
    let encrypted = bytes.starts_with(AGE_MAGIC);
    let zipped: Vec<u8> = if encrypted {
        let pw = password
            .filter(|p| !p.is_empty())
            .ok_or("This file is protected with a password")?;
        let dec = age::Decryptor::new(bytes).map_err(|_| not_ours.clone())?;
        let identity = age::scrypt::Identity::new(age::secrecy::SecretString::from(pw.to_owned()));
        let mut r = dec
            .decrypt(std::iter::once(&identity as &dyn age::Identity))
            .map_err(|_| "Wrong password (or a damaged file)".to_string())?;
        let mut out = Vec::new();
        (&mut r)
            .take(limit + 1)
            .read_to_end(&mut out)
            .map_err(|_| "Wrong password (or a damaged file)".to_string())?;
        if out.len() as u64 > limit {
            return Err(too_big());
        }
        out
    } else {
        bytes.to_vec()
    };
    let mut z = zip::ZipArchive::new(Cursor::new(zipped)).map_err(|_| not_ours.clone())?;
    if z.len() > MAX_ENTRIES {
        return Err("This file has too many entries".into());
    }
    let mut total: u64 = 0;
    let mut manifest: Option<Manifest> = None;
    let mut layer = SharedLayer::default();
    let mut entries = Vec::new();
    for i in 0..z.len() {
        let mut f = z.by_index(i).map_err(|_| not_ours.clone())?;
        if f.is_dir() {
            continue;
        }
        if f.is_symlink() {
            return Err("This file contains a link, which Cerebra doesn't import".into());
        }
        let name = f.name().map_err(|_| not_ours.clone())?.to_string();
        // Count what is really decompressed, not what the archive claims.
        let mut data = Vec::new();
        (&mut f)
            .take(limit - total + 1)
            .read_to_end(&mut data)
            .map_err(|_| not_ours.clone())?;
        total += data.len() as u64;
        if total > limit {
            return Err(too_big());
        }
        match name.as_str() {
            "manifest.json" => manifest = Some(serde_json::from_slice(&data).map_err(|_| not_ours.clone())?),
            "ai-layer.json" => layer = serde_json::from_slice(&data).map_err(|_| not_ours.clone())?,
            _ => {
                let (kind, rel) = safe_entry(&name)
                    .ok_or_else(|| format!("This file contains an unsafe entry ({name})"))?;
                entries.push((kind, rel, data));
            }
        }
    }
    let manifest = manifest.ok_or(not_ours.clone())?;
    if manifest.format != "cerebra" {
        return Err(not_ours);
    }
    if manifest.format_version > FORMAT_VERSION {
        return Err("This file was made by a newer Cerebra. Update Cerebra to open it.".into());
    }
    let sums: HashMap<&str, &str> = manifest
        .files
        .iter()
        .map(|f| (f.path.as_str(), f.sha256.as_str()))
        .collect();
    for (kind, rel, data) in &entries {
        if let Some(expected) = sums.get(format!("{kind}/{rel}").as_str())
            && *expected != sha(data)
        {
            return Err(format!("{rel} is damaged (checksum mismatch)"));
        }
    }
    Ok(Unpacked {
        manifest,
        entries,
        layer,
        encrypted,
    })
}

/// What's inside a share file, without importing it.
pub fn inspect(bytes: &[u8], password: Option<&str>) -> Result<Preview, String> {
    let u = unpack(bytes, password)?;
    let mut notes: Vec<String> = u
        .entries
        .iter()
        .filter(|e| e.0 == "notes")
        .map(|e| e.1.clone())
        .collect();
    notes.sort();
    let counts = Counts {
        notes: notes.len(),
        files: u.entries.iter().filter(|e| e.0 == "files").count(),
        connections: u.layer.connections.len(),
        concepts: u.layer.concepts.len(),
    };
    Ok(Preview {
        title: u.manifest.title,
        description: u.manifest.description,
        created_at: u.manifest.created_at,
        counts,
        notes,
        encrypted: u.encrypted,
    })
}

/// Import a share file as a new collection of the library at `root` (named after the file's
/// title, or `name`; a number is added when that collection exists).
pub fn import_share(
    root: &Path,
    bytes: &[u8],
    password: Option<&str>,
    name: Option<&str>,
) -> Result<ShareImport, String> {
    let u = unpack(bytes, password)?;
    let base = name
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or(&u.manifest.title)
        .to_string();
    let base = if crate::session::valid_name(&base) && !crate::vault::is_ignored_dir(&base) {
        base
    } else {
        "Shared".to_string()
    };
    let collection = (1..)
        .map(|n| {
            if n == 1 {
                base.clone()
            } else {
                format!("{base} ({n})")
            }
        })
        .find(|c| !root.join(c).exists())
        .expect("a free name");
    let dir = root.join(&collection);
    let write_all = || -> Result<(), String> {
        for (_, rel, data) in &u.entries {
            let path = dir.join(rel);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(&path, data).map_err(|e| e.to_string())?;
        }
        Ok(())
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    if let Err(e) = write_all() {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(format!("Couldn't import: {e}"));
    }
    let written: std::collections::HashSet<String> = u
        .entries
        .iter()
        .filter(|e| e.0 == "notes")
        .map(|e| format!("{collection}/{}", e.1))
        .collect();
    let full = |p: &str| format!("{collection}/{p}");
    let connections: Vec<Connection> = u
        .layer
        .connections
        .into_iter()
        .filter(|c| {
            written.contains(&full(&c.from))
                && written.contains(&full(&c.to))
                && crate::ai_layer::TYPES.contains(&c.r#type.as_str())
        })
        .map(|c| Connection {
            id: crate::ai_layer::new_id("c", &c.id),
            from: full(&c.from),
            to: full(&c.to),
            evidence: c
                .evidence
                .iter()
                .map(|e| Evidence {
                    note: full(&e.note),
                    quote: e.quote.clone(),
                })
                .collect(),
            made_by: anonymous(&c.made_by),
            ..c
        })
        .collect();
    let concepts: Vec<Concept> = u
        .layer
        .concepts
        .into_iter()
        .map(|k| Concept {
            id: crate::ai_layer::new_id("k", &k.id),
            collection: collection.clone(),
            notes: k
                .notes
                .iter()
                .map(|p| full(p))
                .filter(|p| written.contains(p))
                .collect(),
            made_by: anonymous(&k.made_by),
            ..k
        })
        .filter(|k| k.notes.len() >= 2)
        .collect();
    let report = ShareImport {
        collection: collection.clone(),
        notes: written.len(),
        files: u.entries.iter().filter(|e| e.0 == "files").count(),
        connections: connections.len(),
        concepts: concepts.len(),
    };
    std::fs::create_dir_all(root.join(crate::session::DATA_DIR)).map_err(|e| e.to_string())?;
    crate::ai_layer::update(root, |l| {
        l.connections.extend(connections);
        l.concepts.extend(concepts);
    })?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_layer::{ConceptInput, ConnectionInput, SaveRequest};

    fn library() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        std::fs::create_dir_all(r.join("Biology/Files")).unwrap();
        std::fs::create_dir_all(r.join("Physics")).unwrap();
        std::fs::create_dir_all(r.join(".cerebra")).unwrap();
        std::fs::write(r.join("Biology/Cells.md"), "Cells have membranes. [[Osmosis]]").unwrap();
        std::fs::write(
            r.join("Biology/Osmosis.md"),
            "Water crosses membranes by osmosis.",
        )
        .unwrap();
        std::fs::write(r.join("Biology/Plants.md"), "Plants take in water through roots.").unwrap();
        std::fs::write(r.join("Biology/Files/unit3.pdf"), b"%PDF-1").unwrap();
        std::fs::write(r.join("Physics/Energy.md"), "Energy and membranes of soap.").unwrap();
        let v = Vault::load(r).unwrap();
        let c = |from: &str, to: &str, qf: &str, qt: &str| ConnectionInput {
            from: from.into(),
            to: to.into(),
            from_anchor: None,
            to_anchor: None,
            r#type: "related".into(),
            reason: "r".into(),
            quote_from: qf.into(),
            quote_to: qt.into(),
            confidence: None,
        };
        let agent = MadeBy {
            kind: "agent".into(),
            source: Some("groq:llama-secret-model".into()),
            job: Some("j_1".into()),
        };
        crate::ai_layer::update(r, |l| {
            let rep = l.apply_save(
                &v,
                SaveRequest {
                    connections: vec![
                        c(
                            "Plants",
                            "Osmosis",
                            "take in water through roots",
                            "Water crosses membranes",
                        ),
                        c("Cells", "Energy", "Cells have membranes", "membranes of soap"),
                        c("Plants", "Cells", "Plants take in water", "Cells have membranes"),
                    ],
                    made_by: agent.clone(),
                    status: None,
                },
            );
            assert_eq!(rep.saved.len(), 3);
            let dismissed = rep.saved[2].clone();
            l.set_status(&[dismissed], Status::Dismissed);
            l.add_concept(
                &v,
                ConceptInput {
                    title: "Water".into(),
                    summary: "Water in cells.".into(),
                    collection: "Biology".into(),
                    notes: vec!["Plants".into(), "Osmosis".into()],
                },
                agent,
            )
            .unwrap();
        })
        .unwrap();
        d
    }

    fn export(d: &tempfile::TempDir, password: Option<&str>) -> Vec<u8> {
        let v = Vault::load(d.path()).unwrap();
        let ai = AiLayer::load(d.path());
        let opts = ExportOptions {
            include_files: true,
            include_suggested: true,
            password: password.map(String::from),
        };
        export_collection(&v, &ai, "Biology", &opts).unwrap()
    }

    #[test]
    fn round_trip_notes_files_and_connections() {
        let src = library();
        let bytes = export(&src, None);
        assert!(bytes.starts_with(b"PK"));
        let p = inspect(&bytes, None).unwrap();
        assert_eq!(p.title, "Biology");
        assert_eq!(
            (
                p.counts.notes,
                p.counts.files,
                p.counts.connections,
                p.counts.concepts
            ),
            (3, 1, 1, 1)
        );

        let dst = tempfile::tempdir().unwrap();
        let r = import_share(dst.path(), &bytes, None, None).unwrap();
        assert_eq!(r.collection, "Biology");
        assert_eq!(
            std::fs::read_to_string(dst.path().join("Biology/Cells.md")).unwrap(),
            "Cells have membranes. [[Osmosis]]"
        );
        assert_eq!(
            std::fs::read(dst.path().join("Biology/Files/unit3.pdf")).unwrap(),
            b"%PDF-1"
        );
        let layer = AiLayer::load(dst.path());
        assert_eq!(layer.connections.len(), 1);
        let c = &layer.connections[0];
        assert_eq!(
            (c.from.as_str(), c.to.as_str()),
            ("Biology/Plants.md", "Biology/Osmosis.md")
        );
        assert_eq!(
            c.made_by.source.as_deref(),
            Some("groq"),
            "only the provider family travels"
        );
        assert_eq!(c.made_by.job, None);
        assert_eq!(
            layer.concepts[0].notes,
            vec!["Biology/Plants.md", "Biology/Osmosis.md"]
        );
    }

    #[test]
    fn export_includes_only_inner_kept_or_suggested() {
        let src = library();
        let bytes = export(&src, None);
        let text = String::from_utf8_lossy(&bytes);
        assert!(
            !text.contains("Energy"),
            "the connection to another collection stays home"
        );
        assert!(
            !text.contains(&*src.path().to_string_lossy()),
            "no absolute paths"
        );
        assert!(!text.contains("j_1") && !text.contains("llama-secret-model"));
        let v = Vault::load(src.path()).unwrap();
        let ai = AiLayer::load(src.path());
        let kept_only = ExportOptions {
            include_files: false,
            include_suggested: false,
            password: None,
        };
        let b2 = export_collection(&v, &ai, "Biology", &kept_only).unwrap();
        let p = inspect(&b2, None).unwrap();
        assert_eq!((p.counts.files, p.counts.connections), (0, 0));
        assert!(export_collection(&v, &ai, "Nope", &kept_only).is_err());
    }

    #[test]
    fn password_round_trip_and_wrong_password() {
        let src = library();
        let bytes = export(&src, Some("correct horse"));
        assert!(bytes.starts_with(b"age-encryption.org/v1"));
        assert!(inspect(&bytes, None).unwrap_err().contains("password"));
        assert!(inspect(&bytes, Some("wrong")).unwrap_err().contains("password"));
        assert_eq!(inspect(&bytes, Some("correct horse")).unwrap().counts.notes, 3);
        let dst = tempfile::tempdir().unwrap();
        assert!(import_share(dst.path(), &bytes, Some("wrong"), None).is_err());
        assert!(
            std::fs::read_dir(dst.path()).unwrap().next().is_none(),
            "nothing written"
        );
    }

    fn zip_with(entries: &[(&str, &[u8])], manifest: &str) -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            let o = zip::write::SimpleFileOptions::default();
            z.start_file("manifest.json", o).unwrap();
            z.write_all(manifest.as_bytes()).unwrap();
            for (name, data) in entries {
                z.start_file(*name, o).unwrap();
                z.write_all(data).unwrap();
            }
            z.finish().unwrap();
        }
        buf.into_inner()
    }

    const MANIFEST: &str = r#"{"format":"cerebra","format_version":1,"app_version":"0.1.0","title":"Evil","description":"","created_at":"2026-01-01T00:00:00Z","counts":{"notes":1,"files":0,"connections":0,"concepts":0}}"#;

    #[test]
    fn import_rejects_unsafe_entries() {
        for bad in [
            "notes/../../escape.md",
            "/etc/x.md",
            "notes/C:/x.md",
            "notes\\..\\x.md",
            "other/x.md",
            "notes/run.exe",
        ] {
            let bytes = zip_with(&[("notes/ok.md", b"ok"), (bad, b"x")], MANIFEST);
            let dst = tempfile::tempdir().unwrap();
            let lib = dst.path().join("lib");
            std::fs::create_dir_all(&lib).unwrap();
            assert!(import_share(&lib, &bytes, None, None).is_err(), "{bad}");
            assert!(
                std::fs::read_dir(&lib).unwrap().next().is_none(),
                "nothing written for {bad}"
            );
            assert!(!dst.path().join("escape.md").exists());
        }
    }

    #[test]
    fn import_errors_are_plain() {
        let dst = tempfile::tempdir().unwrap();
        assert!(
            inspect(b"not a zip at all", None)
                .unwrap_err()
                .contains("isn't a Cerebra file")
        );
        let newer = MANIFEST.replace("\"format_version\":1", "\"format_version\":9");
        let e = inspect(&zip_with(&[("notes/a.md", b"a")], &newer), None).unwrap_err();
        assert!(e.contains("Update Cerebra"), "{e}");
        let src = library();
        let mut bytes = export(&src, None);
        bytes.truncate(bytes.len() / 2);
        assert!(import_share(dst.path(), &bytes, None, None).is_err());
    }

    #[test]
    fn import_renames_on_clash() {
        let src = library();
        let bytes = export(&src, None);
        let r = import_share(src.path(), &bytes, None, None).unwrap();
        assert_eq!(r.collection, "Biology (2)");
        assert!(src.path().join("Biology (2)/Cells.md").is_file());
        let named = import_share(src.path(), &bytes, None, Some("Shared bio")).unwrap();
        assert_eq!(named.collection, "Shared bio");
        let layer = AiLayer::load(src.path());
        assert!(layer.connections.iter().any(|c| c.from == "Shared bio/Plants.md"));
    }

    #[test]
    fn decompression_is_bounded() {
        // A tiny archive that would expand far beyond the limit must be refused, not read whole.
        let big = vec![0u8; 3 * 1024 * 1024];
        let bytes = zip_with(&[("notes/a.md", b"a"), ("files/huge.pdf", &big)], MANIFEST);
        assert!(bytes.len() < 100_000, "compresses well");
        assert!(
            unpack_limited(&bytes, None, 1024 * 1024)
                .err()
                .unwrap()
                .contains("larger")
        );
        assert!(unpack_limited(&bytes, None, 8 * 1024 * 1024).is_ok());
    }
}
