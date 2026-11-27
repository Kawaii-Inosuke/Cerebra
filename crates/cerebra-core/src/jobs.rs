//! Durable agent state in `<library>/.cerebra/state.db` (kept apart from the rebuildable
//! index): the job queue, which notes were connected at which content hash, and AI usage
//! per source per day (docs/04-DATA-MODEL.md §5).

use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::Value;

pub const KINDS: &[&str] = &["connect_note", "connect_collection", "connect_topic"];

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, target TEXT NOT NULL, status TEXT NOT NULL,
  priority INT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
  attempts INT NOT NULL DEFAULT 0, progress_json TEXT, error TEXT, origin TEXT NOT NULL, seq INTEGER
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, priority, seq);
CREATE TABLE IF NOT EXISTS note_state (note_id TEXT PRIMARY KEY, connected_hash TEXT, connected_at TEXT);
CREATE TABLE IF NOT EXISTS usage (day TEXT, source_id TEXT, requests INT, input_tokens INT, output_tokens INT,
  PRIMARY KEY (day, source_id));
";

#[derive(Debug, Clone, Serialize)]
pub struct Job {
    pub id: String,
    pub kind: String,
    pub target: String,
    pub status: String,
    pub priority: i64,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub attempts: i64,
    pub progress: Value,
    pub error: Option<String>,
    pub origin: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Usage {
    pub source_id: String,
    pub requests: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
}

pub struct Jobs {
    conn: Connection,
}

fn priority(origin: &str) -> i64 {
    match origin {
        "user" => 10,
        "assistant" => 5,
        _ => 0,
    }
}

fn today() -> String {
    crate::time::now_iso()[..10].to_string()
}

fn err(e: rusqlite::Error) -> String {
    format!("Agent state error: {e}")
}

fn row_to_job(r: &rusqlite::Row) -> rusqlite::Result<Job> {
    let progress: Option<String> = r.get(9)?;
    Ok(Job {
        id: r.get(0)?,
        kind: r.get(1)?,
        target: r.get(2)?,
        status: r.get(3)?,
        priority: r.get(4)?,
        created_at: r.get(5)?,
        started_at: r.get(6)?,
        finished_at: r.get(7)?,
        attempts: r.get(8)?,
        progress: progress
            .and_then(|p| serde_json::from_str(&p).ok())
            .unwrap_or(Value::Null),
        error: r.get(10)?,
        origin: r.get(11)?,
    })
}

const COLS: &str = "id, kind, target, status, priority, created_at, started_at, finished_at, attempts, progress_json, error, origin";

impl Jobs {
    /// Open `<root>/.cerebra/state.db`. Jobs that were running when the app stopped are queued again.
    pub fn open(root: &Path) -> Result<Jobs, String> {
        let conn = Connection::open(root.join(crate::session::DATA_DIR).join("state.db")).map_err(err)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(err)?;
        conn.execute_batch("PRAGMA journal_mode=WAL;").map_err(err)?;
        conn.execute_batch(SCHEMA).map_err(err)?;
        Ok(Jobs { conn })
    }

    /// Put jobs that were running when the app stopped back in the queue. Only the app does this
    /// (never a `cerebra mcp` process, which would undo the job the app is running right now).
    pub fn requeue_running(&self) -> Result<(), String> {
        self.conn
            .execute("UPDATE jobs SET status = 'queued' WHERE status = 'running'", [])
            .map_err(err)?;
        Ok(())
    }

    /// Queue a job; an identical queued job is reused (and raised to the higher priority).
    pub fn enqueue(&self, kind: &str, target: &str, origin: &str) -> Result<String, String> {
        if !KINDS.contains(&kind) {
            return Err(format!("Unknown job kind: {kind}"));
        }
        let target = target.trim();
        if target.is_empty() || target.chars().count() > 500 {
            return Err("A job needs a note, collection or topic".into());
        }
        let p = priority(origin);
        let existing: Option<(String, i64)> = self
            .conn
            .query_row(
                "SELECT id, priority FROM jobs WHERE status = 'queued' AND kind = ?1 AND target = ?2",
                params![kind, target],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(err)?;
        if let Some((id, old)) = existing {
            if p > old {
                self.conn
                    .execute(
                        "UPDATE jobs SET priority = ?1, origin = ?2 WHERE id = ?3",
                        params![p, origin, id],
                    )
                    .map_err(err)?;
            }
            return Ok(id);
        }
        let id = crate::vault::note_id(&format!(
            "{kind}{target}{}{:?}",
            crate::time::now_iso(),
            std::time::Instant::now()
        ))
        .replacen("n_", "j_", 1);
        self.conn
            .execute(
                "INSERT INTO jobs (id, kind, target, status, priority, created_at, origin, seq)
                 VALUES (?1, ?2, ?3, 'queued', ?4, ?5, ?6, (SELECT COALESCE(MAX(seq), 0) + 1 FROM jobs))",
                params![id, kind, target, p, crate::time::now_iso(), origin],
            )
            .map_err(err)?;
        Ok(id)
    }

    pub fn has_queued(&self) -> Result<bool, String> {
        self.conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM jobs WHERE status = 'queued')",
                [],
                |r| r.get(0),
            )
            .map_err(err)
    }

    /// Take the next queued job (highest priority, then oldest) and mark it running.
    pub fn next(&self) -> Result<Option<Job>, String> {
        let id: Option<String> = self
            .conn
            .query_row(
                "SELECT id FROM jobs WHERE status = 'queued' ORDER BY priority DESC, seq ASC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)?;
        let Some(id) = id else { return Ok(None) };
        self.conn
            .execute(
                "UPDATE jobs SET status = 'running', started_at = ?1, attempts = attempts + 1, error = NULL WHERE id = ?2",
                params![crate::time::now_iso(), id],
            )
            .map_err(err)?;
        self.get(&id)
    }

    pub fn get(&self, id: &str) -> Result<Option<Job>, String> {
        self.conn
            .query_row(
                &format!("SELECT {COLS} FROM jobs WHERE id = ?1"),
                params![id],
                row_to_job,
            )
            .optional()
            .map_err(err)
    }

    /// Newest first.
    pub fn list(&self, limit: usize) -> Result<Vec<Job>, String> {
        let mut st = self
            .conn
            .prepare(&format!("SELECT {COLS} FROM jobs ORDER BY seq DESC LIMIT ?1"))
            .map_err(err)?;
        let rows = st.query_map(params![limit as i64], row_to_job).map_err(err)?;
        rows.collect::<Result<_, _>>().map_err(err)
    }

    pub fn progress(&self, id: &str, progress: &Value) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE jobs SET progress_json = ?1 WHERE id = ?2",
                params![progress.to_string(), id],
            )
            .map(|_| ())
            .map_err(err)
    }

    /// End a job: `done`, `failed`, `cancelled`, or `queued` (paused, to run again later).
    pub fn finish(&self, id: &str, status: &str, error: Option<&str>) -> Result<(), String> {
        let finished = (status != "queued").then(crate::time::now_iso);
        self.conn
            .execute(
                "UPDATE jobs SET status = ?1, error = ?2, finished_at = ?3 WHERE id = ?4",
                params![status, error, finished, id],
            )
            .map(|_| ())
            .map_err(err)
    }

    /// Cancel a queued or running job (a running one is stopped by the runner).
    pub fn cancel(&self, id: &str) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE jobs SET status = 'cancelled', finished_at = ?1 WHERE id = ?2 AND status IN ('queued', 'running')",
                params![crate::time::now_iso(), id],
            )
            .map(|_| ())
            .map_err(err)
    }

    pub fn connected_hash(&self, note: &str) -> Result<Option<String>, String> {
        self.conn
            .query_row(
                "SELECT connected_hash FROM note_state WHERE note_id = ?1",
                params![note],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)
    }

    pub fn mark_connected(&self, note: &str, hash: &str) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO note_state (note_id, connected_hash, connected_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(note_id) DO UPDATE SET connected_hash = excluded.connected_hash, connected_at = excluded.connected_at",
                params![note, hash, crate::time::now_iso()],
            )
            .map(|_| ())
            .map_err(err)
    }

    pub fn usage_add(&self, source: &str, requests: i64, input: i64, output: i64) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO usage (day, source_id, requests, input_tokens, output_tokens) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(day, source_id) DO UPDATE SET requests = requests + excluded.requests,
                   input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens",
                params![today(), source, requests, input, output],
            )
            .map(|_| ())
            .map_err(err)
    }

    pub fn usage_today(&self) -> Result<Vec<Usage>, String> {
        let mut st = self
            .conn
            .prepare("SELECT source_id, requests, input_tokens, output_tokens FROM usage WHERE day = ?1 ORDER BY source_id")
            .map_err(err)?;
        let rows = st
            .query_map(params![today()], |r| {
                Ok(Usage {
                    source_id: r.get(0)?,
                    requests: r.get(1)?,
                    input_tokens: r.get(2)?,
                    output_tokens: r.get(3)?,
                })
            })
            .map_err(err)?;
        rows.collect::<Result<_, _>>().map_err(err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jobs() -> (tempfile::TempDir, Jobs) {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join(".cerebra")).unwrap();
        let j = Jobs::open(d.path()).unwrap();
        (d, j)
    }

    #[test]
    fn enqueue_dedupes_queued_jobs() {
        let (_d, j) = jobs();
        let a = j.enqueue("connect_note", "Biology/Cells.md", "auto").unwrap();
        let b = j.enqueue("connect_note", "Biology/Cells.md", "user").unwrap();
        assert_eq!(a, b);
        assert_eq!(j.list(10).unwrap().len(), 1);
        assert_eq!(
            j.get(&a).unwrap().unwrap().origin,
            "user",
            "a user request upgrades the queued job"
        );
        assert!(j.enqueue("delete_everything", "x", "user").is_err());
        assert!(j.enqueue("connect_topic", "  ", "user").is_err());
    }

    #[test]
    fn jobs_survive_reopen_and_running_jobs_are_requeued() {
        let (d, j) = jobs();
        let id = j.enqueue("connect_collection", "Biology", "user").unwrap();
        assert_eq!(j.next().unwrap().unwrap().id, id);
        drop(j);
        let j = Jobs::open(d.path()).unwrap();
        assert_eq!(
            j.get(&id).unwrap().unwrap().status,
            "running",
            "opening alone changes nothing"
        );
        j.requeue_running().unwrap();
        let job = j.get(&id).unwrap().unwrap();
        assert_eq!(
            job.status, "queued",
            "a job running when the app stopped goes back to the queue"
        );
        assert_eq!(job.attempts, 1);
    }

    #[test]
    fn next_returns_highest_priority_then_oldest() {
        let (_d, j) = jobs();
        let auto1 = j.enqueue("connect_note", "a.md", "auto").unwrap();
        let _auto2 = j.enqueue("connect_note", "b.md", "auto").unwrap();
        let user = j.enqueue("connect_topic", "Osmosis", "user").unwrap();
        assert_eq!(j.next().unwrap().unwrap().id, user);
        let n = j.next().unwrap().unwrap();
        assert_eq!(n.id, auto1);
        assert_eq!(n.status, "running");
        assert!(n.started_at.is_some());
    }

    #[test]
    fn cancel_and_finish() {
        let (_d, j) = jobs();
        let a = j.enqueue("connect_note", "a.md", "auto").unwrap();
        let b = j.enqueue("connect_note", "b.md", "auto").unwrap();
        j.cancel(&a).unwrap();
        assert_eq!(j.get(&a).unwrap().unwrap().status, "cancelled");
        let running = j.next().unwrap().unwrap();
        assert_eq!(running.id, b);
        j.progress(
            &b,
            &serde_json::json!({"stage": "linking", "done": 2, "total": 5}),
        )
        .unwrap();
        assert_eq!(j.get(&b).unwrap().unwrap().progress["stage"], "linking");
        j.finish(&b, "failed", Some("All AI sources are resting"))
            .unwrap();
        let f = j.get(&b).unwrap().unwrap();
        assert_eq!(
            (f.status.as_str(), f.error.as_deref()),
            ("failed", Some("All AI sources are resting"))
        );
        assert!(f.finished_at.is_some());
        assert!(j.next().unwrap().is_none());
    }

    #[test]
    fn mark_connected_skips_unchanged_notes() {
        let (_d, j) = jobs();
        assert_eq!(j.connected_hash("a.md").unwrap(), None);
        j.mark_connected("a.md", "sha256:1").unwrap();
        j.mark_connected("a.md", "sha256:2").unwrap();
        assert_eq!(j.connected_hash("a.md").unwrap().as_deref(), Some("sha256:2"));
    }

    #[test]
    fn usage_accumulates_per_day() {
        let (_d, j) = jobs();
        j.usage_add("s1", 1, 100, 20).unwrap();
        j.usage_add("s1", 2, 50, 5).unwrap();
        j.usage_add("s2", 1, 1, 1).unwrap();
        let t = j.usage_today().unwrap();
        let s1 = t.iter().find(|u| u.source_id == "s1").unwrap();
        assert_eq!((s1.requests, s1.input_tokens, s1.output_tokens), (3, 150, 25));
        assert_eq!(t.len(), 2);
    }
}
