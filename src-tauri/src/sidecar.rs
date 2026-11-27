//! The agents program (`cerebra-agents`, Python + Strands) as a child process: JSON-RPC
//! requests on its stdin, responses and notifications from its stdout (doc 06 §1).

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::time::Duration;

use serde_json::{Value, json};

pub struct Sidecar {
    child: Child,
    stdin: ChildStdin,
    events: Receiver<Value>,
    next_id: u64,
}

impl Sidecar {
    /// Start `cmd[0]` with the rest as arguments. Its stderr (logs, already redacted) goes to `log`.
    pub fn start(cmd: &[String], log: Option<std::path::PathBuf>) -> Result<Sidecar, String> {
        let (prog, args) = cmd.split_first().ok_or("no agents command")?;
        let stderr =
            match log.and_then(|p| std::fs::OpenOptions::new().create(true).append(true).open(p).ok()) {
                Some(f) => Stdio::from(f),
                None => Stdio::null(),
            };
        let mut command = Command::new(prog);
        #[cfg(windows)]
        {
            // No console window for the agents on Windows.
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = command
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(stderr)
            .spawn()
            .map_err(|e| format!("Couldn't start the agents ({prog}): {e}"))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let (tx, events) = channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(v) = serde_json::from_str::<Value>(&line)
                    && tx.send(v).is_err()
                {
                    break;
                }
            }
        });
        Ok(Sidecar {
            child,
            stdin,
            events,
            next_id: 1,
        })
    }

    /// Send a request; returns its id.
    pub fn request(&mut self, method: &str, params: Value) -> Result<u64, String> {
        let id = self.next_id;
        self.next_id += 1;
        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        writeln!(self.stdin, "{msg}")
            .and_then(|_| self.stdin.flush())
            .map_err(|e| format!("The agents stopped: {e}"))?;
        Ok(id)
    }

    /// The next message from the agents, or `Ok(None)` after `timeout`; `Err` if they exited.
    pub fn recv(&self, timeout: Duration) -> Result<Option<Value>, String> {
        match self.events.recv_timeout(timeout) {
            Ok(v) => Ok(Some(v)),
            Err(RecvTimeoutError::Timeout) => Ok(None),
            Err(RecvTimeoutError::Disconnected) => Err("The agents stopped unexpectedly".into()),
        }
    }

    pub fn running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        let _ = self.request("shutdown", json!({}));
        std::thread::sleep(Duration::from_millis(50));
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
