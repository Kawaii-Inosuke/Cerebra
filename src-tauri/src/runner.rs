//! Runs agent jobs one at a time: takes the next job from the library's queue, hands it to
//! the agents with the enabled AI sources, records progress and usage, and finishes it.
//! Also queues changed notes for auto-connect (30 s after the last change).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cerebra_core::session::Session;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::sidecar::Sidecar;

/// Agent settings (`<app data>/agents.json`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub auto_connect: bool,
    /// `strict` | `balanced` | `generous` (doc 06 §4).
    pub threshold: String,
    /// Save new connections as kept instead of suggested.
    pub trust: bool,
    /// Model calls per job.
    pub budget: u32,
    pub paused: bool,
    pub auto_delay_secs: u64,
    /// Collections whose notes may only go to AI running on this computer (doc 08 §3).
    pub local_only: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            auto_connect: true,
            threshold: "balanced".into(),
            trust: false,
            budget: 40,
            paused: false,
            auto_delay_secs: 30,
            local_only: Vec::new(),
        }
    }
}

impl Settings {
    pub fn load(file: &std::path::Path) -> Settings {
        std::fs::read_to_string(file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }
    pub fn save(&self, file: &std::path::Path) -> Result<(), String> {
        std::fs::write(file, serde_json::to_string_pretty(self).unwrap()).map_err(|e| e.to_string())
    }
}

pub type Emit = Box<dyn Fn(&str, Value) + Send>;

pub struct Runner {
    session: Arc<Mutex<Option<Session>>>,
    agents_cmd: Vec<String>,
    /// Command for the agents' tools; the library path is appended.
    mcp_cmd: Vec<String>,
    emit: Emit,
    sidecar: Option<Sidecar>,
    pub log: Option<PathBuf>,
    /// Note hashes when the library was opened or last auto-queued.
    known: HashMap<String, String>,
    last_change: Option<Instant>,
    /// All sources are resting: don't start jobs before this.
    wait_until: Option<Instant>,
    pub statuses: HashMap<String, Value>,
}

fn parse_iso(s: &str) -> Option<i64> {
    // YYYY-MM-DDTHH:MM:SSZ → unix seconds (enough for "resume at").
    let b = s.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let n = |a: usize, l: usize| s.get(a..a + l)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (n(0, 4)?, n(5, 2)?, n(8, 2)?, n(11, 2)?, n(14, 2)?, n(17, 2)?);
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146_097 + doe - 719_468) * 86_400 + h * 3600 + mi * 60 + se)
}

impl Runner {
    pub fn new(
        session: Arc<Mutex<Option<Session>>>,
        agents_cmd: Vec<String>,
        mcp_cmd: Vec<String>,
        emit: Emit,
    ) -> Runner {
        Runner {
            session,
            agents_cmd,
            mcp_cmd,
            emit,
            sidecar: None,
            log: None,
            known: HashMap::new(),
            last_change: None,
            wait_until: None,
            statuses: HashMap::new(),
        }
    }

    /// Run `f` on the open session, if any.
    pub fn with_session<R>(&self, f: impl FnOnce(&mut Session) -> R) -> Option<R> {
        self.session.lock().ok()?.as_mut().map(f)
    }

    /// Remember the current note hashes (call when a library is opened).
    pub fn snapshot(&mut self) {
        self.known = self
            .with_session(|s| {
                s.workspace()
                    .vault
                    .notes
                    .iter()
                    .map(|n| (n.path.clone(), n.hash.clone()))
                    .collect()
            })
            .unwrap_or_default();
        self.wait_until = None;
    }

    pub fn library_changed(&mut self) {
        self.last_change = Some(Instant::now());
    }

    /// Queue notes that are new or changed since the snapshot and not yet connected at their
    /// current text, once the library has been quiet for `auto_delay_secs`. Returns how many.
    pub fn auto_enqueue(&mut self, settings: &Settings) -> usize {
        let Some(at) = self.last_change else { return 0 };
        if at.elapsed() < Duration::from_secs(settings.auto_delay_secs) {
            return 0;
        }
        self.last_change = None;
        if !settings.auto_connect {
            self.snapshot();
            return 0;
        }
        let known = std::mem::take(&mut self.known);
        let (n, now) = self
            .with_session(|s| {
                let changed = s.changed_notes();
                let notes: HashMap<String, String> = s
                    .workspace()
                    .vault
                    .notes
                    .iter()
                    .map(|n| (n.path.clone(), n.hash.clone()))
                    .collect();
                let mut n = 0;
                for p in changed {
                    if known.get(&p) != notes.get(&p) && s.jobs().enqueue("connect_note", &p, "auto").is_ok()
                    {
                        n += 1;
                    }
                }
                (n, notes)
            })
            .unwrap_or_default();
        self.known = now;
        n
    }

    /// Run the next job, if there is one and work is allowed. `local` = the sources running on
    /// this computer, used for jobs in local-only collections. Returns whether a job ran.
    pub fn tick(&mut self, sources: &[Value], local: &[Value], settings: &Settings) -> Result<bool, String> {
        if settings.paused || sources.is_empty() || self.wait_until.is_some_and(|t| Instant::now() < t) {
            return Ok(false);
        }
        self.wait_until = None;
        let Some(job) = self.with_session(|s| s.jobs().next()).transpose()?.flatten() else {
            return Ok(false);
        };
        if job.kind == "connect_collection" {
            self.with_session(|s| -> Result<(), String> {
                let prefix = format!("{}/", job.target);
                for p in s.changed_notes().into_iter().filter(|p| p.starts_with(&prefix)) {
                    s.jobs().enqueue("connect_note", &p, &job.origin)?;
                }
                s.jobs().finish(&job.id, "done", None)
            })
            .transpose()?;
            (self.emit)("job-done", json!({ "job_id": job.id, "status": "done" }));
            return Ok(true);
        }
        let private = cerebra_core::collection::collection_of(&job.target)
            .or_else(|| (job.kind == "connect_collection").then(|| job.target.clone()))
            .is_some_and(|c| settings.local_only.contains(&c));
        let sources = if private { local } else { sources };
        if sources.is_empty() {
            let msg =
                "This collection is local-only: add a model that runs on this computer (Ollama or LM Studio)";
            self.with_session(|s| s.jobs().finish(&job.id, "failed", Some(msg)))
                .transpose()?;
            (self.emit)(
                "job-done",
                json!({ "job_id": job.id, "status": "failed", "error": msg }),
            );
            return Ok(true);
        }
        let root = self
            .with_session(|s| s.root().to_string_lossy().into_owned())
            .ok_or("no library")?;
        // The tools may not see local-only collections while a cloud source does the thinking.
        let mut mcp_args: Vec<String> = self.mcp_cmd[1..self.mcp_cmd.len() - 1].to_vec();
        if !private {
            for c in &settings.local_only {
                mcp_args.push("--exclude".into());
                mcp_args.push(c.clone());
            }
        }
        mcp_args.push(self.mcp_cmd[self.mcp_cmd.len() - 1].clone());
        mcp_args.push(root.clone());
        let params = json!({
            "job": {
                "id": job.id, "kind": job.kind, "target": job.target,
                "options": { "threshold": settings.threshold, "trust": settings.trust, "budget": settings.budget },
            },
            "sources": sources,
            "library": root,
            "mcp": { "command": self.mcp_cmd[0], "args": mcp_args },
        });
        let result = self.run(&job.id, params);
        let (status, error) = match &result {
            Ok(r) => {
                let st = r["status"].as_str().unwrap_or("failed").to_string();
                (st, r["error"].as_str().map(String::from))
            }
            Err(e) => ("failed".into(), Some(e.clone())),
        };
        let stored = if status == "paused" {
            "queued"
        } else {
            status.as_str()
        };
        if status == "paused" {
            let resume = result
                .as_ref()
                .ok()
                .and_then(|r| r["next_ready_at"].as_str())
                .and_then(parse_iso);
            let now = cerebra_core::time::now_iso();
            let wait = resume
                .zip(parse_iso(&now))
                .map(|(a, b)| (a - b).clamp(30, 3600) as u64)
                .unwrap_or(60);
            self.wait_until = Some(Instant::now() + Duration::from_secs(wait));
        }
        let cancelled = self
            .with_session(|s| s.jobs().get(&job.id))
            .transpose()?
            .flatten()
            .is_some_and(|j| j.status == "cancelled");
        self.with_session(|s| -> Result<(), String> {
            if !cancelled {
                s.jobs().finish(&job.id, stored, error.as_deref())?;
            }
            if status == "done" && job.kind == "connect_note" {
                let _ = s.mark_connected(&job.target);
            }
            s.reload_ai();
            Ok(())
        })
        .transpose()?;
        (self.emit)(
            "job-done",
            json!({ "job_id": job.id, "status": stored, "error": error, "saved": result.as_ref().ok().map(|r| r["saved"].clone()) }),
        );
        (self.emit)("ai-changed", json!({}));
        Ok(true)
    }

    fn ensure_sidecar(&mut self) -> Result<&mut Sidecar, String> {
        if !self.sidecar.as_mut().is_some_and(|s| s.running()) {
            self.sidecar = Some(Sidecar::start(&self.agents_cmd, self.log.clone())?);
        }
        Ok(self.sidecar.as_mut().unwrap())
    }

    /// Send `run_job` and handle the agents' messages until its result arrives.
    fn run(&mut self, job_id: &str, params: Value) -> Result<Value, String> {
        let id = self.ensure_sidecar()?.request("run_job", params)?;
        let mut cancel_sent = false;
        loop {
            let msg = match self.sidecar.as_ref().unwrap().recv(Duration::from_millis(500)) {
                Ok(m) => m,
                Err(e) => {
                    self.sidecar = None;
                    return Err(e);
                }
            };
            let Some(msg) = msg else {
                let cancelled = self
                    .with_session(|s| s.jobs().get(job_id))
                    .and_then(|r| r.ok().flatten())
                    .is_some_and(|j| j.status == "cancelled");
                if cancelled && !cancel_sent {
                    self.sidecar
                        .as_mut()
                        .unwrap()
                        .request("cancel", json!({ "job_id": job_id }))?;
                    cancel_sent = true;
                }
                continue;
            };
            if msg.get("id").and_then(Value::as_u64) == Some(id) {
                if let Some(e) = msg.get("error") {
                    return Err(e["message"].as_str().unwrap_or("The agents failed").to_string());
                }
                return Ok(msg["result"].clone());
            }
            let p = msg["params"].clone();
            match msg["method"].as_str().unwrap_or_default() {
                "progress" => {
                    let _ = self.with_session(|s| s.jobs().progress(job_id, &p));
                    (self.emit)("job-progress", p);
                }
                "usage" => {
                    let n = |k: &str| p[k].as_i64().unwrap_or(0);
                    let src = p["source_id"].as_str().unwrap_or_default().to_string();
                    let total = self.with_session(|s| {
                        let _ =
                            s.jobs()
                                .usage_add(&src, n("requests"), n("input_tokens"), n("output_tokens"));
                        s.jobs()
                            .usage_today()
                            .ok()?
                            .into_iter()
                            .find(|u| u.source_id == src)
                    });
                    // The UI shows today's totals, so send those rather than this one call.
                    match total.flatten() {
                        Some(u) => (self.emit)("usage", json!(u)),
                        None => (self.emit)("usage", p),
                    }
                }
                "source_status" => {
                    if let Some(src) = p["source_id"].as_str() {
                        self.statuses.insert(src.to_string(), p.clone());
                    }
                    (self.emit)("source-status", p);
                }
                _ => {}
            }
        }
    }

    /// Ask the agents to try one source (starts them if needed). Blocks up to 60 s.
    pub fn test_source(&mut self, source: Value) -> Result<Value, String> {
        let id = self
            .ensure_sidecar()?
            .request("test_source", json!({ "source": source }))?;
        let deadline = Instant::now() + Duration::from_secs(60);
        while Instant::now() < deadline {
            if let Some(msg) = self.sidecar.as_ref().unwrap().recv(Duration::from_millis(500))?
                && msg.get("id").and_then(Value::as_u64) == Some(id)
            {
                return Ok(msg["result"].clone());
            }
        }
        Err("The test took too long".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FAKE: &str = r#"
import json, sys
for line in sys.stdin:
    m = json.loads(line)
    if m["method"] == "run_job":
        job = m["params"]["job"]
        assert m["params"]["sources"][0]["api_key"] == "k1"
        assert m["params"]["mcp"]["args"][-1] == m["params"]["library"]
        if job["target"] == "Biology/Osmosis.md":
            a = m["params"]["mcp"]["args"]
            assert "--exclude" in a and a[a.index("--exclude") + 1] == "Physics", a
        print(json.dumps({"jsonrpc":"2.0","method":"progress","params":{"job_id":job["id"],"stage":"linking","done":1,"total":2,"message":"x"}}), flush=True)
        print(json.dumps({"jsonrpc":"2.0","method":"usage","params":{"source_id":"s1","requests":2,"input_tokens":300,"output_tokens":40}}), flush=True)
        status = "paused" if job["target"] == "Busy" else "done"
        print(json.dumps({"jsonrpc":"2.0","id":m["id"],"result":{"status":status,"saved":{"connections":1,"concepts":0},"next_ready_at":"2099-01-01T00:00:00Z"}}), flush=True)
    elif m["method"] == "shutdown":
        break
"#;

    type Events = Arc<Mutex<Vec<(String, Value)>>>;

    #[test]
    fn local_only_collections_never_get_cloud_sources() {
        let (_d, mut r, _) = setup();
        let id = r
            .with_session(|s| s.jobs().enqueue("connect_note", "Biology/Cells.md", "user"))
            .unwrap()
            .unwrap();
        let settings = Settings {
            local_only: vec!["Biology".into()],
            ..Settings::default()
        };
        assert!(r.tick(&sources(), &[], &settings).unwrap());
        let job = r.with_session(|s| s.jobs().get(&id)).unwrap().unwrap().unwrap();
        assert_eq!(job.status, "failed");
        assert!(job.error.unwrap().contains("local-only"));
    }

    #[test]
    fn cloud_jobs_exclude_local_only_collections_from_the_tools() {
        let (_d, mut r, _) = setup();
        let id = r
            .with_session(|s| s.jobs().enqueue("connect_note", "Biology/Osmosis.md", "user"))
            .unwrap()
            .unwrap();
        let settings = Settings {
            local_only: vec!["Physics".into()],
            ..Settings::default()
        };
        assert!(r.tick(&sources(), &[], &settings).unwrap());
        assert_eq!(
            r.with_session(|s| s.jobs().get(&id))
                .unwrap()
                .unwrap()
                .unwrap()
                .status,
            "done"
        );
    }

    fn setup() -> (tempfile::TempDir, Runner, Events) {
        let d = tempfile::tempdir().unwrap();
        let lib = d.path().join("lib");
        std::fs::create_dir_all(lib.join("Biology")).unwrap();
        std::fs::write(lib.join("Biology/Cells.md"), "Cells have membranes.").unwrap();
        std::fs::write(lib.join("Biology/Osmosis.md"), "Water crosses membranes.").unwrap();
        let script = d.path().join("fake.py");
        std::fs::write(&script, FAKE).unwrap();
        let session = Arc::new(Mutex::new(Some(Session::open(&lib).unwrap())));
        let events = Arc::new(Mutex::new(Vec::new()));
        let ev = events.clone();
        let runner = Runner::new(
            session,
            vec!["python3".into(), script.to_string_lossy().into_owned()],
            vec![
                "cerebra".into(),
                "mcp".into(),
                "--agent".into(),
                "--library".into(),
            ],
            Box::new(move |name: &str, v: Value| ev.lock().unwrap().push((name.to_string(), v))),
        );
        (d, runner, events)
    }

    fn sources() -> Vec<Value> {
        vec![json!({"id": "s1", "provider": "groq", "model": "m", "api_key": "k1", "local": false})]
    }

    #[test]
    fn runner_picks_next_and_records_usage() {
        let (_d, mut r, events) = setup();
        let id = r
            .with_session(|s| s.jobs().enqueue("connect_note", "Biology/Cells.md", "user"))
            .unwrap()
            .unwrap();
        assert!(r.tick(&sources(), &[], &Settings::default()).unwrap());
        let job = r.with_session(|s| s.jobs().get(&id)).unwrap().unwrap().unwrap();
        assert_eq!(job.status, "done");
        assert_eq!(job.progress["stage"], "linking");
        let usage = r.with_session(|s| s.jobs().usage_today()).unwrap().unwrap();
        assert_eq!((usage[0].requests, usage[0].input_tokens), (2, 300));
        r.with_session(|s| s.jobs().enqueue("connect_note", "Biology/Cells.md", "user"))
            .unwrap()
            .unwrap();
        r.tick(&sources(), &[], &Settings::default()).unwrap();
        let last_usage = events
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|e| e.0 == "usage")
            .unwrap()
            .1
            .clone();
        assert_eq!(
            last_usage["requests"], 4,
            "usage events carry today's totals, not the last call"
        );
        let changed = r.with_session(|s| s.changed_notes()).unwrap();
        assert!(
            !changed.contains(&"Biology/Cells.md".to_string()),
            "marked connected"
        );
        let names: Vec<String> = events.lock().unwrap().iter().map(|e| e.0.clone()).collect();
        for n in ["job-progress", "usage", "job-done", "ai-changed"] {
            assert!(names.contains(&n.to_string()), "{n} in {names:?}");
        }
        assert!(
            !r.tick(&sources(), &[], &Settings::default()).unwrap(),
            "queue empty"
        );
    }

    #[test]
    fn no_sources_or_paused_means_no_work() {
        let (_d, mut r, _) = setup();
        r.with_session(|s| s.jobs().enqueue("connect_note", "Biology/Cells.md", "user"))
            .unwrap()
            .unwrap();
        assert!(!r.tick(&[], &[], &Settings::default()).unwrap());
        let paused = Settings {
            paused: true,
            ..Settings::default()
        };
        assert!(!r.tick(&sources(), &[], &paused).unwrap());
    }

    #[test]
    fn paused_job_goes_back_to_queue_and_runner_waits() {
        let (_d, mut r, _) = setup();
        let id = r
            .with_session(|s| s.jobs().enqueue("connect_topic", "Busy", "user"))
            .unwrap()
            .unwrap();
        assert!(r.tick(&sources(), &[], &Settings::default()).unwrap());
        assert_eq!(
            r.with_session(|s| s.jobs().get(&id))
                .unwrap()
                .unwrap()
                .unwrap()
                .status,
            "queued"
        );
        assert!(
            !r.tick(&sources(), &[], &Settings::default()).unwrap(),
            "waits until the sources are ready"
        );
    }

    #[test]
    fn collection_jobs_expand_to_changed_notes() {
        let (_d, mut r, _) = setup();
        r.with_session(|s| s.mark_connected("Biology/Osmosis.md"))
            .unwrap()
            .unwrap();
        let id = r
            .with_session(|s| s.jobs().enqueue("connect_collection", "Biology", "user"))
            .unwrap()
            .unwrap();
        assert!(r.tick(&sources(), &[], &Settings::default()).unwrap());
        let jobs = r.with_session(|s| s.jobs().list(10)).unwrap().unwrap();
        assert_eq!(jobs.iter().find(|j| j.id == id).unwrap().status, "done");
        let notes: Vec<&str> = jobs
            .iter()
            .filter(|j| j.kind == "connect_note")
            .map(|j| j.target.as_str())
            .collect();
        assert_eq!(notes, vec!["Biology/Cells.md"]);
    }

    #[test]
    fn auto_connect_only_changed_notes() {
        let (d, mut r, _) = setup();
        r.snapshot();
        std::fs::write(
            d.path().join("lib/Biology/Osmosis.md"),
            "Water crosses membranes by osmosis.",
        )
        .unwrap();
        r.with_session(|s| s.reload()).unwrap().unwrap();
        r.library_changed();
        let settings = Settings {
            auto_delay_secs: 0,
            ..Settings::default()
        };
        assert_eq!(r.auto_enqueue(&settings), 1);
        let jobs = r.with_session(|s| s.jobs().list(10)).unwrap().unwrap();
        assert_eq!(
            (jobs[0].target.as_str(), jobs[0].origin.as_str()),
            ("Biology/Osmosis.md", "auto")
        );
        assert_eq!(r.auto_enqueue(&settings), 0, "nothing new");
        let off = Settings {
            auto_connect: false,
            auto_delay_secs: 0,
            ..Settings::default()
        };
        r.library_changed();
        assert_eq!(r.auto_enqueue(&off), 0);
    }
}
