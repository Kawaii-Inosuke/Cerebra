//! Local SQLite index: notes, links (the graph), chunks and full-text search (FTS5).
//! Schema follows docs/04-DATA-MODEL.md §5. Everything here can be rebuilt from the library.

use std::path::Path;

use rusqlite::{Connection, params};
use serde::Serialize;

use crate::chunk::chunk_note;
use crate::graph::LinkIndex;
use crate::vault::{Vault, note_id};

pub struct Store {
    conn: Connection,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SearchHit {
    pub note_id: String,
    pub path: String,
    pub title: String,
    pub heading_path: String,
    pub snippet: String,
    pub line: usize,
    pub score: f64,
}

/// One indexed passage (a note section) with its note.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ChunkRow {
    pub id: i64,
    pub note_id: String,
    pub path: String,
    pub title: String,
    pub heading_path: String,
    pub text: String,
    pub line: usize,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct IndexStats {
    pub notes: usize,
    pub links: usize,
    pub chunks: usize,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY, collection TEXT, path TEXT UNIQUE, title TEXT,
  body TEXT, summary TEXT, frontmatter_json TEXT, hash TEXT
);
CREATE TABLE IF NOT EXISTS aliases  (note_id TEXT, alias TEXT);
CREATE TABLE IF NOT EXISTS tags     (note_id TEXT, tag TEXT);
CREATE TABLE IF NOT EXISTS headings (note_id TEXT, level INT, text TEXT, line INT);
CREATE TABLE IF NOT EXISTS blocks   (note_id TEXT, block_id TEXT, line INT);
CREATE TABLE IF NOT EXISTS links (
  src TEXT, dst TEXT NULL, target_text TEXT, subpath TEXT, display TEXT,
  is_embed INT, kind TEXT, line INT
);
CREATE INDEX IF NOT EXISTS links_src ON links(src);
CREATE INDEX IF NOT EXISTS links_dst ON links(dst);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY, note_id TEXT, heading_path TEXT, text TEXT, tokens INT, line INT
);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text, heading_path, title, chunk_id UNINDEXED, tokenize = 'unicode61 remove_diacritics 2'
);
"#;

impl Store {
    pub fn open(path: impl AsRef<Path>) -> rusqlite::Result<Store> {
        Store::init(Connection::open(path)?)
    }

    pub fn open_in_memory() -> rusqlite::Result<Store> {
        Store::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> rusqlite::Result<Store> {
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.execute_batch(SCHEMA)?;
        Ok(Store { conn })
    }

    /// Replace the whole index with `vault` in one transaction.
    pub fn rebuild(&mut self, vault: &Vault, idx: &LinkIndex) -> rusqlite::Result<IndexStats> {
        let tx = self.conn.transaction()?;
        tx.execute_batch(
            "DELETE FROM notes; DELETE FROM aliases; DELETE FROM tags; DELETE FROM headings;
             DELETE FROM blocks; DELETE FROM links; DELETE FROM chunks; DELETE FROM chunks_fts;",
        )?;
        let mut stats = IndexStats {
            notes: 0,
            links: 0,
            chunks: 0,
        };
        {
            let mut ins_note = tx.prepare(
                "INSERT INTO notes (id, collection, path, title, body, frontmatter_json, hash)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            let mut ins_alias = tx.prepare("INSERT INTO aliases VALUES (?1, ?2)")?;
            let mut ins_tag = tx.prepare("INSERT INTO tags VALUES (?1, ?2)")?;
            let mut ins_head = tx.prepare("INSERT INTO headings VALUES (?1, ?2, ?3, ?4)")?;
            let mut ins_block = tx.prepare("INSERT INTO blocks VALUES (?1, ?2, ?3)")?;
            let mut ins_chunk = tx.prepare(
                "INSERT INTO chunks (note_id, heading_path, text, tokens, line) VALUES (?1, ?2, ?3, ?4, ?5)",
            )?;
            let mut ins_fts = tx.prepare(
                "INSERT INTO chunks_fts (text, heading_path, title, chunk_id) VALUES (?1, ?2, ?3, ?4)",
            )?;
            for n in &vault.notes {
                ins_note.execute(params![
                    n.id,
                    crate::collection::collection_of(&n.path),
                    n.path,
                    n.title,
                    n.text,
                    n.meta.frontmatter.to_string(),
                    n.hash
                ])?;
                for a in &n.meta.aliases {
                    ins_alias.execute(params![n.id, a])?;
                }
                for t in &n.meta.tags {
                    ins_tag.execute(params![n.id, t])?;
                }
                for h in &n.meta.headings {
                    ins_head.execute(params![n.id, h.level, h.text, h.line as i64])?;
                }
                for b in &n.meta.blocks {
                    ins_block.execute(params![n.id, b.id, b.line as i64])?;
                }
                let titles = std::iter::once(n.title.clone())
                    .chain(n.meta.aliases.iter().cloned())
                    .collect::<Vec<_>>()
                    .join(" ");
                for c in chunk_note(n) {
                    ins_chunk.execute(params![
                        n.id,
                        c.heading_path,
                        c.text,
                        c.tokens as i64,
                        c.line as i64
                    ])?;
                    let chunk_id = tx.last_insert_rowid();
                    ins_fts.execute(params![c.text, c.heading_path, titles, chunk_id])?;
                    stats.chunks += 1;
                }
                stats.notes += 1;
            }
            let mut ins_link = tx.prepare("INSERT INTO links VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")?;
            for e in &idx.edges {
                ins_link.execute(params![
                    note_id(&e.src),
                    e.dst.as_deref().map(|d| if d.to_lowercase().ends_with(".md") {
                        note_id(d)
                    } else {
                        d.to_string()
                    }),
                    e.target_text,
                    e.subpath,
                    e.display,
                    e.embed,
                    serde_json::to_value(e.kind)
                        .ok()
                        .and_then(|v| v.as_str().map(String::from)),
                    e.line as i64
                ])?;
                stats.links += 1;
            }
        }
        tx.commit()?;
        Ok(stats)
    }

    /// Full-text search over chunks. All terms must match; if nothing does, any term may.
    /// At most 2 chunks per note. Lower score = better (BM25).
    /// Full-text search, optionally only within one collection (filtered before the limit).
    pub fn search(
        &self,
        query: &str,
        collection: Option<&str>,
        limit: usize,
    ) -> rusqlite::Result<Vec<SearchHit>> {
        let terms = fts_terms(query);
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        let mut hits = self.run_search(&terms.join(" "), collection, limit)?;
        if hits.is_empty() && terms.len() > 1 {
            hits = self.run_search(&terms.join(" OR "), collection, limit)?;
        }
        Ok(hits)
    }

    fn run_search(
        &self,
        fts: &str,
        collection: Option<&str>,
        limit: usize,
    ) -> rusqlite::Result<Vec<SearchHit>> {
        // Column weights: text 1, heading path 2, title/aliases 3.
        let mut stmt = self.conn.prepare(
            "SELECT n.id, n.path, n.title, c.heading_path,
                    snippet(chunks_fts, 0, '**', '**', '…', 16), c.line,
                    bm25(chunks_fts, 1.0, 2.0, 3.0) AS score
             FROM chunks_fts
             JOIN chunks c ON c.id = chunks_fts.chunk_id
             JOIN notes n ON n.id = c.note_id
             WHERE chunks_fts MATCH ?1 AND (?3 IS NULL OR n.collection = ?3)
             ORDER BY score LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![fts, (limit * 4) as i64, collection], |r| {
            Ok(SearchHit {
                note_id: r.get(0)?,
                path: r.get(1)?,
                title: r.get(2)?,
                heading_path: r.get(3)?,
                snippet: r.get(4)?,
                line: r.get::<_, i64>(5)? as usize,
                score: r.get(6)?,
            })
        })?;
        let mut per_note = std::collections::HashMap::<String, usize>::new();
        let mut out = Vec::new();
        for hit in rows {
            let hit = hit?;
            let n = per_note.entry(hit.note_id.clone()).or_default();
            if *n < 2 {
                *n += 1;
                out.push(hit);
            }
            if out.len() == limit {
                break;
            }
        }
        Ok(out)
    }

    /// `(source note id, source title, line)` for links pointing at `note_id`.
    pub fn backlinks(&self, note_id: &str) -> rusqlite::Result<Vec<(String, String, usize)>> {
        let mut stmt = self.conn.prepare(
            "SELECT l.src, n.title, l.line FROM links l JOIN notes n ON n.id = l.src
             WHERE l.dst = ?1 AND l.src != ?1 ORDER BY n.path, l.line",
        )?;
        let rows = stmt.query_map(params![note_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? as usize))
        })?;
        rows.collect()
    }

    /// Full text of the chunk at `(note, heading path, line)`, as indexed.
    /// Every chunk with its note (for search by meaning and outlines), in note + line order.
    pub fn all_chunks(&self) -> rusqlite::Result<Vec<ChunkRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT c.id, n.id, n.path, n.title, c.heading_path, c.text, c.line
             FROM chunks c JOIN notes n ON n.id = c.note_id ORDER BY n.path, c.line",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(ChunkRow {
                id: r.get(0)?,
                note_id: r.get(1)?,
                path: r.get(2)?,
                title: r.get(3)?,
                heading_path: r.get(4)?,
                text: r.get(5)?,
                line: r.get::<_, i64>(6)? as usize,
            })
        })?;
        rows.collect()
    }

    /// Chunk ids that match any of the question's meaningful words, best first (BM25).
    /// Common words ("what", "is", "about"…) are left out so they don't drown the rest.
    pub fn keyword_ranks(
        &self,
        query: &str,
        collection: Option<&str>,
        limit: usize,
    ) -> rusqlite::Result<Vec<i64>> {
        let terms: Vec<String> = query
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| !w.is_empty() && !crate::retrieve::is_stopword(&w.to_lowercase()))
            .map(|w| format!("\"{}\"", w.to_lowercase()))
            .collect();
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        let mut stmt = self.conn.prepare(
            "SELECT c.id FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.chunk_id
             JOIN notes n ON n.id = c.note_id
             WHERE chunks_fts MATCH ?1 AND (?3 IS NULL OR n.collection = ?3)
             ORDER BY bm25(chunks_fts, 1.0, 2.0, 3.0) LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![terms.join(" OR "), limit as i64, collection], |r| {
            r.get(0)
        })?;
        rows.collect()
    }

    pub fn chunk_text(
        &self,
        note_id: &str,
        heading_path: &str,
        line: usize,
    ) -> rusqlite::Result<Option<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT text FROM chunks WHERE note_id = ?1 AND heading_path = ?2 AND line = ?3 LIMIT 1",
        )?;
        let mut rows = stmt.query(params![note_id, heading_path, line as i64])?;
        Ok(match rows.next()? {
            Some(r) => Some(r.get(0)?),
            None => None,
        })
    }

    pub fn note_count(&self) -> rusqlite::Result<usize> {
        self.conn
            .query_row("SELECT COUNT(*) FROM notes", [], |r| r.get::<_, i64>(0))
            .map(|n| n as usize)
    }
}

/// Turn free text into safe FTS5 terms: each word quoted (so `-`, `:`, `*` etc. can't
/// break the query syntax).
fn fts_terms(query: &str) -> Vec<String> {
    query
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| format!("\"{}\"", w.to_lowercase()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (Store, Vault) {
        let v = Vault::from_notes([
            (
                "Biology/Exam Plan.md",
                "---\naliases: [Mid-term]\n---\n# Timeline\nExam date is 12 March.\n## Topics\nCell membranes [[Membranes]]",
            ),
            (
                "Biology/Membranes.md",
                "Phospholipids form the bilayer. See [[Exam Plan#Topics]].",
            ),
            ("Study/Process.md", "How we revise for exams: weekly check-ins."),
        ]);
        let idx = LinkIndex::build(&v);
        let mut s = Store::open_in_memory().unwrap();
        let stats = s.rebuild(&v, &idx).unwrap();
        assert_eq!(stats.notes, 3);
        assert_eq!(stats.links, 2);
        (s, v)
    }

    #[test]
    fn search_finds_chunks_with_heading_paths() {
        let (s, _) = store();
        let hits = s.search("exam date", None, 5).unwrap();
        assert_eq!(hits[0].title, "Exam Plan");
        assert_eq!(hits[0].heading_path, "Exam Plan › Timeline");
        assert!(hits[0].snippet.contains("**Exam**") || hits[0].snippet.contains("**date**"));
    }

    #[test]
    fn search_matches_aliases_and_falls_back_to_or() {
        let (s, _) = store();
        assert_eq!(s.search("mid-term", None, 5).unwrap()[0].title, "Exam Plan");
        assert!(
            !s.search("phospholipids nonexistentword", None, 5)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn hostile_queries_do_not_error() {
        let (s, _) = store();
        for q in ["\"", "a AND", "NEAR(", "*", "col:x", "-", "   "] {
            s.search(q, None, 5).unwrap();
        }
    }

    #[test]
    fn backlinks_from_db() {
        let (s, _) = store();
        let bl = s.backlinks(&note_id("Biology/Exam Plan.md")).unwrap();
        assert_eq!(bl.len(), 1);
        assert_eq!(bl[0].1, "Membranes");
    }

    fn crowded() -> (Store, Vault) {
        let mut notes: Vec<(String, String)> =
            vec![("Biology/Cells.md".into(), "Osmosis in plant cells.".into())];
        for i in 0..61 {
            notes.push((
                format!("Physics/p{i}.md"),
                format!("Osmosis pressure example {i}."),
            ));
        }
        let v = Vault::from_notes(notes.iter().map(|(a, b)| (a.as_str(), b.as_str())));
        let idx = LinkIndex::build(&v);
        let mut s = Store::open_in_memory().unwrap();
        s.rebuild(&v, &idx).unwrap();
        (s, v)
    }

    #[test]
    fn search_filters_by_collection_before_limiting() {
        let (s, _) = crowded();
        let hits = s.search("osmosis", Some("Biology"), 5).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "Biology/Cells.md");
        assert_eq!(s.keyword_ranks("osmosis", Some("Biology"), 60).unwrap().len(), 1);
        assert_eq!(s.search("osmosis", None, 100).unwrap().len(), 62);
    }

    #[test]
    fn rebuild_is_idempotent() {
        let (mut s, v) = store();
        let idx = LinkIndex::build(&v);
        s.rebuild(&v, &idx).unwrap();
        assert_eq!(s.note_count().unwrap(), 3);
    }
}
