//! The **AI layer**: connections and concept notes made by AI (the Strands agents or an AI
//! app through the connector), kept in `<library>/.cerebra/ai-layer.json`, apart from the
//! user's own notes, which are never edited from here (docs/04-DATA-MODEL.md §3).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::vault::Vault;

pub const FILE: &str = "ai-layer.json";
pub const MAX_PER_SAVE: usize = 60;
const MAX_CONNECTIONS: usize = 50_000;
const MAX_CONCEPTS: usize = 5_000;
const MAX_REASON: usize = 600;
const MAX_QUOTE: usize = 400;
const BACKUPS: usize = 10;
pub const TYPES: &[&str] = &[
    "explains",
    "builds_on",
    "example_of",
    "contrasts",
    "same_concept",
    "cause_effect",
    "part_of",
    "related",
];
/// Types where A→B means the same as B→A.
const SYMMETRIC: &[&str] = &["contrasts", "same_concept", "related"];

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    #[default]
    Suggested,
    Kept,
    Dismissed,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MadeBy {
    /// `agent` (the Strands workflow), `assistant` (an AI app via the connector) or `user`.
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Evidence {
    pub note: String,
    pub quote: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Connection {
    pub id: String,
    pub from: String,
    pub to: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_anchor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_anchor: Option<String>,
    pub r#type: String,
    pub reason: String,
    pub evidence: Vec<Evidence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
    pub status: Status,
    pub made_by: MadeBy,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Concept {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub collection: String,
    pub notes: Vec<String>,
    pub made_by: MadeBy,
    pub status: Status,
    pub created_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AiLayer {
    #[serde(default = "one")]
    pub version: u32,
    #[serde(default)]
    pub connections: Vec<Connection>,
    #[serde(default)]
    pub concepts: Vec<Concept>,
}

fn one() -> u32 {
    1
}

/// One connection as an AI proposes it (`from`/`to` = note path, title or id).
#[derive(Debug, Clone, Deserialize)]
pub struct ConnectionInput {
    pub from: String,
    pub to: String,
    #[serde(default)]
    pub from_anchor: Option<String>,
    #[serde(default)]
    pub to_anchor: Option<String>,
    pub r#type: String,
    pub reason: String,
    pub quote_from: String,
    pub quote_to: String,
    #[serde(default)]
    pub confidence: Option<f32>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SaveRequest {
    pub connections: Vec<ConnectionInput>,
    pub made_by: MadeBy,
    #[serde(default)]
    pub status: Option<Status>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Rejected {
    pub index: usize,
    pub reason: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct SaveReport {
    pub saved: Vec<String>,
    pub rejected: Vec<Rejected>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConceptInput {
    pub title: String,
    pub summary: String,
    pub collection: String,
    pub notes: Vec<String>,
}

pub(crate) fn new_id(prefix: &str, salt: &str) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let h = Sha256::digest(format!("{nanos}:{n}:{}:{salt}", std::process::id()).as_bytes());
    format!("{prefix}_{}", &hex::encode(h)[..16])
}

fn normalise(s: &str) -> Vec<String> {
    s.to_lowercase()
        .chars()
        .filter(|c| !"*_`#>[]()!|".contains(*c))
        .collect::<String>()
        .split_whitespace()
        .map(|w| w.trim_matches(|c: char| ".,;:?\"'“”‘’".contains(c)).to_string())
        .filter(|w| !w.is_empty())
        .collect()
}

/// Is `quote` really in `text`? Exact after normalising formatting, or (for quotes of five
/// words or more) a window of the text sharing at least 90% of the quote's words.
pub fn verify_quote(text: &str, quote: &str) -> bool {
    let q = normalise(quote);
    if q.is_empty() {
        return false;
    }
    let t = normalise(text);
    let (qs, ts) = (q.join(" "), t.join(" "));
    if format!(" {ts} ").contains(&format!(" {qs} ")) {
        return true;
    }
    if q.len() < 5 || t.len() < q.len() {
        return false;
    }
    let need = (q.len() as f32 * 0.9).ceil() as usize;
    t.windows(q.len()).any(|w| {
        let mut pool: Vec<&String> = w.iter().collect();
        let hits = q
            .iter()
            .filter(|word| {
                pool.iter()
                    .position(|p| p == word)
                    .map(|i| pool.swap_remove(i))
                    .is_some()
            })
            .count();
        hits >= need
    })
}

fn same_pair(c: &Connection, from: &str, to: &str, t: &str) -> bool {
    c.r#type == t
        && ((c.from == from && c.to == to) || (SYMMETRIC.contains(&t) && c.from == to && c.to == from))
}

impl AiLayer {
    /// The layer of the library at `root` (empty if there's none yet or it can't be read).
    pub fn load(root: &Path) -> AiLayer {
        std::fs::read_to_string(path_of(root))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    /// Check and add proposed connections. Each one is saved or rejected with a reason.
    pub fn apply_save(&mut self, vault: &Vault, req: SaveRequest) -> SaveReport {
        let mut report = SaveReport::default();
        let status = req.status.unwrap_or_default();
        for (index, c) in req.connections.into_iter().enumerate() {
            let reject = |r: &mut SaveReport, reason: &str| {
                r.rejected.push(Rejected {
                    index,
                    reason: reason.into(),
                })
            };
            if index >= MAX_PER_SAVE || self.connections.len() >= MAX_CONNECTIONS {
                reject(&mut report, "limit");
                continue;
            }
            if c.reason.chars().count() > MAX_REASON
                || c.quote_from.chars().count() > MAX_QUOTE
                || c.quote_to.chars().count() > MAX_QUOTE
            {
                reject(&mut report, "too_long");
                continue;
            }
            let (Some(from), Some(to)) = (vault.find_note(&c.from), vault.find_note(&c.to)) else {
                reject(&mut report, "unknown_note");
                continue;
            };
            if from.path == to.path {
                reject(&mut report, "same_note");
                continue;
            }
            if !TYPES.contains(&c.r#type.as_str()) {
                reject(&mut report, "bad_type");
                continue;
            }
            if !verify_quote(&from.text, &c.quote_from) || !verify_quote(&to.text, &c.quote_to) {
                reject(&mut report, "quote_not_found");
                continue;
            }
            let matching = self
                .connections
                .iter()
                .find(|x| same_pair(x, &from.path, &to.path, &c.r#type));
            match matching {
                Some(x) if x.status == Status::Dismissed => {
                    reject(&mut report, "dismissed_before");
                    continue;
                }
                Some(_) => {
                    reject(&mut report, "duplicate");
                    continue;
                }
                None => {}
            }
            let id = new_id("c", &format!("{}{}", from.path, to.path));
            self.connections.push(Connection {
                id: id.clone(),
                from: from.path.clone(),
                to: to.path.clone(),
                from_anchor: c.from_anchor,
                to_anchor: c.to_anchor,
                r#type: c.r#type,
                reason: c.reason.trim().to_string(),
                evidence: vec![
                    Evidence {
                        note: from.path.clone(),
                        quote: c.quote_from.trim().to_string(),
                    },
                    Evidence {
                        note: to.path.clone(),
                        quote: c.quote_to.trim().to_string(),
                    },
                ],
                confidence: c.confidence.map(|x| x.clamp(0.0, 1.0)),
                status,
                made_by: req.made_by.clone(),
                created_at: crate::time::now_iso(),
            });
            report.saved.push(id);
        }
        report
    }

    /// Add a concept note linking at least two existing notes of an existing collection.
    pub fn add_concept(&mut self, vault: &Vault, c: ConceptInput, made_by: MadeBy) -> Result<String, String> {
        if self.concepts.len() >= MAX_CONCEPTS {
            return Err("Too many concept notes in this library".into());
        }
        let title = c.title.trim();
        if title.is_empty() || title.chars().count() > 120 || c.summary.chars().count() > 2_000 {
            return Err("A concept needs a short title and summary".into());
        }
        if !crate::collection::collections(vault)
            .iter()
            .any(|(n, _)| *n == c.collection)
        {
            return Err(format!("Collection not found: {}", c.collection));
        }
        let mut seen = HashSet::new();
        let notes: Vec<String> = c
            .notes
            .iter()
            .filter_map(|n| vault.find_note(n))
            .map(|n| n.path.clone())
            .filter(|p| seen.insert(p.clone()))
            .collect();
        if notes.len() < 2 {
            return Err("A concept must link at least two existing notes".into());
        }
        if let Some(existing) = self
            .concepts
            .iter()
            .find(|k| k.title.eq_ignore_ascii_case(title) && k.collection == c.collection)
        {
            return Ok(existing.id.clone());
        }
        let id = new_id("k", title);
        self.concepts.push(Concept {
            id: id.clone(),
            title: title.to_string(),
            summary: c.summary.trim().to_string(),
            collection: c.collection,
            notes,
            made_by,
            status: Status::Suggested,
            created_at: crate::time::now_iso(),
        });
        Ok(id)
    }

    /// Change the status of connections and concepts by id; returns how many changed.
    pub fn set_status(&mut self, ids: &[String], status: Status) -> usize {
        let mut n = 0;
        for c in self.connections.iter_mut().filter(|c| ids.contains(&c.id)) {
            c.status = status;
            n += 1;
        }
        for k in self.concepts.iter_mut().filter(|k| ids.contains(&k.id)) {
            k.status = status;
            n += 1;
        }
        n
    }

    /// Connections whose notes both exist, not dismissed.
    pub fn visible<'a>(&'a self, vault: &'a Vault) -> impl Iterator<Item = &'a Connection> + 'a {
        self.connections.iter().filter(move |c| {
            c.status != Status::Dismissed
                && vault.note_by_path(&c.from).is_some()
                && vault.note_by_path(&c.to).is_some()
        })
    }

    /// Visible connections touching the note at `path`.
    pub fn for_note<'a>(&'a self, vault: &'a Vault, path: &str) -> Vec<&'a Connection> {
        self.visible(vault)
            .filter(|c| c.from == path || c.to == path)
            .collect()
    }

    /// Concepts that aren't dismissed, with only the notes that still exist.
    pub fn visible_concepts(&self, vault: &Vault) -> Vec<Concept> {
        self.concepts
            .iter()
            .filter(|k| k.status != Status::Dismissed)
            .map(|k| {
                let mut k = k.clone();
                k.notes.retain(|p| vault.note_by_path(p).is_some());
                k
            })
            .filter(|k| !k.notes.is_empty())
            .collect()
    }
}

fn path_of(root: &Path) -> PathBuf {
    root.join(crate::session::DATA_DIR).join(FILE)
}

struct Lock(PathBuf);

impl Lock {
    fn take(root: &Path) -> Result<Lock, String> {
        let path = root.join(crate::session::DATA_DIR).join("ai-layer.lock");
        for _ in 0..500 {
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(_) => return Ok(Lock(path)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    let stale = std::fs::metadata(&path)
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.elapsed().ok())
                        .is_some_and(|age| age > Duration::from_secs(10));
                    if stale {
                        let _ = std::fs::remove_file(&path);
                    } else {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                }
                Err(e) => return Err(format!("Couldn't lock the AI layer: {e}")),
            }
        }
        Err("The AI layer is busy; try again".into())
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Change the layer of the library at `root` safely: lock, re-read, change, back up, write.
pub fn update<R>(root: &Path, f: impl FnOnce(&mut AiLayer) -> R) -> Result<R, String> {
    let _lock = Lock::take(root)?;
    let mut layer = AiLayer::load(root);
    let out = f(&mut layer);
    let file = path_of(root);
    if file.exists() {
        let dir = root.join(crate::session::DATA_DIR).join("backups");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let stamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::fs::copy(&file, dir.join(format!("ai-layer-{stamp:024}.json"))).map_err(|e| e.to_string())?;
        let mut old: Vec<PathBuf> = std::fs::read_dir(&dir)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                p.file_name()
                    .is_some_and(|n| n.to_string_lossy().starts_with("ai-layer-"))
            })
            .collect();
        old.sort();
        while old.len() > BACKUPS {
            let _ = std::fs::remove_file(old.remove(0));
        }
    }
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&layer).unwrap()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &file).map_err(|e| e.to_string())?;
    Ok(out)
}

/// Save proposed connections into the layer of the library at `root`.
pub fn save_connections(root: &Path, vault: &Vault, req: SaveRequest) -> Result<SaveReport, String> {
    update(root, |l| l.apply_save(vault, req))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault() -> Vault {
        Vault::from_notes([
            (
                "Biology/Osmosis.md",
                "# Osmosis\nWater moves across a **semi-permeable** membrane by osmosis.",
            ),
            (
                "Biology/Membranes.md",
                "The cell membrane is selectively permeable.\nIt is made of a phospholipid bilayer.",
            ),
            (
                "Biology/Plants.md",
                "Plant cells take in water by osmosis through their membrane.",
            ),
        ])
    }

    fn input(from: &str, to: &str, t: &str, qf: &str, qt: &str) -> ConnectionInput {
        ConnectionInput {
            from: from.into(),
            to: to.into(),
            from_anchor: None,
            to_anchor: None,
            r#type: t.into(),
            reason: "Osmosis depends on the membrane's permeability.".into(),
            quote_from: qf.into(),
            quote_to: qt.into(),
            confidence: Some(0.8),
        }
    }

    fn good() -> ConnectionInput {
        input(
            "Osmosis",
            "Biology/Membranes.md",
            "builds_on",
            "across a semi-permeable membrane",
            "selectively permeable",
        )
    }

    fn agent() -> MadeBy {
        MadeBy {
            kind: "agent".into(),
            source: Some("groq:llama".into()),
            job: Some("j1".into()),
        }
    }

    fn req(c: Vec<ConnectionInput>) -> SaveRequest {
        SaveRequest {
            connections: c,
            made_by: agent(),
            status: None,
        }
    }

    #[test]
    fn verify_quote_accepts_formatting_differences() {
        let text = "# Osmosis\nWater moves across a **semi-permeable**\n  membrane by osmosis.";
        assert!(verify_quote(text, "across a semi-permeable membrane"));
        assert!(verify_quote(text, "Water Moves Across a Semi-Permeable Membrane"));
        // one small word off in a long quote is still the same passage
        assert!(verify_quote(
            "the cell membrane is selectively permeable and it is made of a phospholipid bilayer of lipids",
            "the cell membrane is selectively permeable and it is made of a phospholipid bilayer of fats"
        ));
    }

    #[test]
    fn verify_quote_rejects_invented_text() {
        let text = "Water moves across a semi-permeable membrane by osmosis.";
        assert!(!verify_quote(text, "osmosis requires ATP from mitochondria"));
        assert!(!verify_quote(text, ""));
        assert!(!verify_quote(text, "   "));
    }

    #[test]
    fn save_rejects_unverified_quotes_and_enforces_limits() {
        let v = vault();
        let mut l = AiLayer::default();
        let mut cs = vec![
            good(),
            input(
                "Osmosis",
                "Membranes",
                "builds_on",
                "osmosis needs ATP",
                "selectively permeable",
            ),
            input("Osmosis", "Nope", "explains", "osmosis", "x"),
            input("Osmosis", "Osmosis", "explains", "osmosis", "osmosis"),
            input("Osmosis", "Plants", "teleports", "osmosis", "osmosis"),
        ];
        let mut long = input(
            "Plants",
            "Membranes",
            "related",
            "by osmosis",
            "selectively permeable",
        );
        long.reason = "x".repeat(601);
        cs.push(long);
        let r = l.apply_save(&v, req(cs));
        assert_eq!(r.saved.len(), 1);
        let reasons: Vec<&str> = r.rejected.iter().map(|x| x.reason.as_str()).collect();
        assert_eq!(
            reasons,
            vec![
                "quote_not_found",
                "unknown_note",
                "same_note",
                "bad_type",
                "too_long"
            ]
        );
        assert_eq!(l.connections[0].from, "Biology/Osmosis.md");
        assert_eq!(l.connections[0].status, Status::Suggested);
        assert_eq!(l.connections[0].evidence.len(), 2);

        let many: Vec<_> = (0..MAX_PER_SAVE + 5).map(|_| good()).collect();
        let r = AiLayer::default().apply_save(&v, req(many));
        assert!(r.rejected.iter().any(|x| x.reason == "limit"));
    }

    #[test]
    fn dismissed_connections_are_never_saved_again() {
        let v = vault();
        let mut l = AiLayer::default();
        let id = l.apply_save(&v, req(vec![good()])).saved[0].clone();
        assert_eq!(l.set_status(&[id], Status::Dismissed), 1);
        let r = l.apply_save(&v, req(vec![good()]));
        assert_eq!(r.rejected[0].reason, "dismissed_before");
        assert_eq!(l.connections.len(), 1);
    }

    #[test]
    fn duplicates_and_reverse_symmetric_are_merged() {
        let v = vault();
        let mut l = AiLayer::default();
        l.apply_save(&v, req(vec![good()]));
        assert_eq!(
            l.apply_save(&v, req(vec![good()])).rejected[0].reason,
            "duplicate"
        );
        let sym = input(
            "Osmosis",
            "Plants",
            "same_concept",
            "by osmosis",
            "water by osmosis",
        );
        let rev = input(
            "Plants",
            "Osmosis",
            "same_concept",
            "water by osmosis",
            "by osmosis",
        );
        l.apply_save(&v, req(vec![sym]));
        assert_eq!(l.apply_save(&v, req(vec![rev])).rejected[0].reason, "duplicate");
        // a directed type in the other direction is a different connection
        let back = input(
            "Membranes",
            "Osmosis",
            "builds_on",
            "selectively permeable",
            "semi-permeable membrane",
        );
        assert!(l.apply_save(&v, req(vec![back])).rejected.is_empty());
    }

    #[test]
    fn connections_to_missing_notes_are_hidden() {
        let v = vault();
        let mut l = AiLayer::default();
        l.apply_save(&v, req(vec![good()]));
        let smaller = Vault::from_notes([("Biology/Osmosis.md", "x")]);
        assert_eq!(l.visible(&v).count(), 1);
        assert_eq!(l.visible(&smaller).count(), 0);
        assert_eq!(l.connections.len(), 1, "kept in the file");
        assert!(l.for_note(&smaller, "Biology/Osmosis.md").is_empty());
    }

    #[test]
    fn concurrent_saves_do_not_lose_connections() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join(".cerebra")).unwrap();
        let mut notes = Vec::new();
        for i in 0..40 {
            notes.push((format!("N/n{i}.md"), format!("shared words here {i}")));
        }
        let v = std::sync::Arc::new(Vault::from_notes(
            notes.iter().map(|(a, b)| (a.as_str(), b.as_str())),
        ));
        let root = d.path().to_path_buf();
        let handles: Vec<_> = (0..2)
            .map(|t| {
                let v = v.clone();
                let root = root.clone();
                std::thread::spawn(move || {
                    for i in 0..20 {
                        let a = format!("N/n{}.md", t * 20 + i);
                        let b = format!("N/n{}.md", (t * 20 + i + 1) % 40);
                        let c = input(&a, &b, "explains", "shared words here", "shared words here");
                        save_connections(&root, &v, req(vec![c])).unwrap();
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(AiLayer::load(&root).connections.len(), 40);
    }

    #[test]
    fn backups_roll_at_10() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join(".cerebra")).unwrap();
        let v = vault();
        for _ in 0..14 {
            update(d.path(), |l| {
                l.concepts.clear();
            })
            .unwrap();
        }
        let n = std::fs::read_dir(d.path().join(".cerebra/backups"))
            .unwrap()
            .count();
        assert_eq!(n, 10);
        let _ = v;
    }

    #[test]
    fn concepts_need_existing_notes_and_a_collection() {
        let v = vault();
        let mut l = AiLayer::default();
        let ok = ConceptInput {
            title: "Water transport".into(),
            summary: "How water moves in cells.".into(),
            collection: "Biology".into(),
            notes: vec!["Osmosis".into(), "Plants".into(), "Ghost".into()],
        };
        let id = l.add_concept(&v, ok, agent()).unwrap();
        assert!(id.starts_with("k_"));
        assert_eq!(
            l.concepts[0].notes,
            vec!["Biology/Osmosis.md", "Biology/Plants.md"]
        );
        let bad = ConceptInput {
            title: "X".into(),
            summary: "y".into(),
            collection: "Nope".into(),
            notes: vec!["Osmosis".into(), "Plants".into()],
        };
        assert!(l.add_concept(&v, bad, agent()).is_err());
        let one = ConceptInput {
            title: "Y".into(),
            summary: "y".into(),
            collection: "Biology".into(),
            notes: vec!["Osmosis".into()],
        };
        assert!(l.add_concept(&v, one, agent()).is_err());
    }
}
