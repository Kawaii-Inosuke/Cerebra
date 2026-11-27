//! One-click setup of Cerebra's connector in AI desktop apps (docs/07-CONNECTOR-MCP.md §1):
//! adds `cerebra = { command: <this app>, args: ["mcp"] }` to the app's MCP config, after
//! backing the file up. Other servers in the file are never touched.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

const NAME: &str = "cerebra";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiApp {
    ClaudeDesktop,
    ClaudeCode,
    Codex,
    Cursor,
}

impl AiApp {
    pub const ALL: [AiApp; 4] = [
        AiApp::ClaudeDesktop,
        AiApp::ClaudeCode,
        AiApp::Codex,
        AiApp::Cursor,
    ];

    pub fn parse(s: &str) -> Option<AiApp> {
        Some(match s {
            "claude_desktop" => AiApp::ClaudeDesktop,
            "claude_code" => AiApp::ClaudeCode,
            "codex" => AiApp::Codex,
            "cursor" => AiApp::Cursor,
            _ => return None,
        })
    }

    pub fn id(self) -> &'static str {
        match self {
            AiApp::ClaudeDesktop => "claude_desktop",
            AiApp::ClaudeCode => "claude_code",
            AiApp::Codex => "codex",
            AiApp::Cursor => "cursor",
        }
    }
}

/// Where the user's home and config folders are (injected in tests).
pub struct Paths {
    pub home: PathBuf,
    pub config: PathBuf,
}

impl Paths {
    pub fn system() -> Option<Paths> {
        Some(Paths {
            home: dirs::home_dir()?,
            config: dirs::config_dir()?,
        })
    }
}

pub fn target_file(app: AiApp, p: &Paths) -> PathBuf {
    match app {
        AiApp::ClaudeDesktop => p.config.join("Claude").join("claude_desktop_config.json"),
        AiApp::ClaudeCode => p.home.join(".claude.json"),
        AiApp::Codex => p.home.join(".codex").join("config.toml"),
        AiApp::Cursor => p.home.join(".cursor").join("mcp.json"),
    }
}

fn backup(file: &Path) -> Result<(), String> {
    if file.exists() {
        let stamp = cerebra_core::time::now_iso().replace(':', "-");
        let name = format!(
            "{}.cerebra-backup-{stamp}",
            file.file_name().unwrap().to_string_lossy()
        );
        std::fs::copy(file, file.with_file_name(name))
            .map_err(|e| format!("Couldn't back up the config: {e}"))?;
    }
    Ok(())
}

fn read_json(file: &Path) -> Result<Value, String> {
    let text = match std::fs::read_to_string(file) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(json!({})),
        Err(e) => return Err(format!("Cerebra couldn't read {}: {e}", file.display())),
    };
    if text.trim().is_empty() {
        return Ok(json!({}));
    }
    match serde_json::from_str::<Value>(&text) {
        Ok(v) if v.is_object() => Ok(v),
        _ => Err(format!(
            "Cerebra couldn't read {} (it isn't valid JSON), so it left it unchanged",
            file.display()
        )),
    }
}

fn read_toml(file: &Path) -> Result<toml_edit::DocumentMut, String> {
    let text = match std::fs::read_to_string(file) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("Cerebra couldn't read {}: {e}", file.display())),
    };
    text.parse::<toml_edit::DocumentMut>().map_err(|_| {
        format!(
            "Cerebra couldn't read {} (it isn't valid TOML), so it left it unchanged",
            file.display()
        )
    })
}

fn write(file: &Path, text: &str) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    backup(file)?;
    std::fs::write(file, text).map_err(|e| format!("Couldn't save {}: {e}", file.display()))
}

/// Is Cerebra set up in this app?
pub fn status(app: AiApp, p: &Paths) -> bool {
    let file = target_file(app, p);
    match app {
        AiApp::Codex => read_toml(&file)
            .ok()
            .is_some_and(|d| d.get("mcp_servers").and_then(|m| m.get(NAME)).is_some()),
        _ => read_json(&file)
            .ok()
            .is_some_and(|v| v["mcpServers"].get(NAME).is_some()),
    }
}

/// Add (or update) Cerebra in the app's config. `exe` = this program.
pub fn connect(app: AiApp, p: &Paths, exe: &str) -> Result<(), String> {
    let file = target_file(app, p);
    match app {
        AiApp::Codex => {
            let mut doc = read_toml(&file)?;
            if !doc.contains_key("mcp_servers") {
                let mut t = toml_edit::Table::new();
                t.set_implicit(true);
                doc["mcp_servers"] = toml_edit::Item::Table(t);
            }
            let mut entry = toml_edit::Table::new();
            entry["command"] = toml_edit::value(exe);
            let mut args = toml_edit::Array::new();
            args.push("mcp");
            entry["args"] = toml_edit::value(args);
            doc["mcp_servers"][NAME] = toml_edit::Item::Table(entry);
            write(&file, &doc.to_string())
        }
        _ => {
            let mut v = read_json(&file)?;
            if !v["mcpServers"].is_object() {
                v["mcpServers"] = json!({});
            }
            v["mcpServers"][NAME] = json!({ "command": exe, "args": ["mcp"] });
            write(&file, &serde_json::to_string_pretty(&v).unwrap())
        }
    }
}

/// Remove Cerebra from the app's config (nothing else).
pub fn disconnect(app: AiApp, p: &Paths) -> Result<(), String> {
    let file = target_file(app, p);
    if !file.exists() || !status(app, p) {
        return Ok(());
    }
    match app {
        AiApp::Codex => {
            let mut doc = read_toml(&file)?;
            if let Some(t) = doc.get_mut("mcp_servers").and_then(|m| m.as_table_mut()) {
                t.remove(NAME);
            }
            write(&file, &doc.to_string())
        }
        _ => {
            let mut v = read_json(&file)?;
            if let Some(m) = v["mcpServers"].as_object_mut() {
                m.remove(NAME);
            }
            write(&file, &serde_json::to_string_pretty(&v).unwrap())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths() -> (tempfile::TempDir, Paths) {
        let d = tempfile::tempdir().unwrap();
        let p = Paths {
            home: d.path().join("home"),
            config: d.path().join("config"),
        };
        (d, p)
    }

    #[test]
    fn connector_setup_preserves_other_servers() {
        let (_d, p) = paths();
        let file = target_file(AiApp::ClaudeDesktop, &p);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(
            &file,
            r#"{"mcpServers":{"other":{"command":"x"}},"theme":"dark"}"#,
        )
        .unwrap();
        connect(AiApp::ClaudeDesktop, &p, "/opt/Cerebra/cerebra").unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(v["mcpServers"]["other"]["command"], "x");
        assert_eq!(v["theme"], "dark");
        assert_eq!(v["mcpServers"]["cerebra"]["command"], "/opt/Cerebra/cerebra");
        assert_eq!(v["mcpServers"]["cerebra"]["args"], serde_json::json!(["mcp"]));
        let backups = std::fs::read_dir(file.parent().unwrap())
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .contains("cerebra-backup")
            })
            .count();
        assert_eq!(backups, 1);
        assert!(status(AiApp::ClaudeDesktop, &p));

        let toml = target_file(AiApp::Codex, &p);
        std::fs::create_dir_all(toml.parent().unwrap()).unwrap();
        std::fs::write(&toml, "model = \"o4\"\n\n[mcp_servers.other]\ncommand = \"y\"\n").unwrap();
        connect(AiApp::Codex, &p, "/opt/Cerebra/cerebra").unwrap();
        let t = std::fs::read_to_string(&toml).unwrap();
        assert!(
            t.contains("model = \"o4\"") && t.contains("[mcp_servers.other]"),
            "{t}"
        );
        assert!(
            t.contains("[mcp_servers.cerebra]") && t.contains("command = \"/opt/Cerebra/cerebra\""),
            "{t}"
        );
        assert!(status(AiApp::Codex, &p));
    }

    #[test]
    fn missing_config_is_created() {
        let (_d, p) = paths();
        assert!(!status(AiApp::Cursor, &p));
        connect(AiApp::Cursor, &p, "C:\\Cerebra\\cerebra.exe").unwrap();
        assert!(status(AiApp::Cursor, &p));
        connect(AiApp::ClaudeCode, &p, "/x").unwrap();
        assert!(status(AiApp::ClaudeCode, &p));
    }

    #[test]
    fn malformed_config_untouched() {
        let (_d, p) = paths();
        let file = target_file(AiApp::ClaudeDesktop, &p);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "{ broken json").unwrap();
        assert!(
            connect(AiApp::ClaudeDesktop, &p, "/x")
                .unwrap_err()
                .contains("couldn't read")
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{ broken json");
        let toml = target_file(AiApp::Codex, &p);
        std::fs::create_dir_all(toml.parent().unwrap()).unwrap();
        std::fs::write(&toml, "[[[ nope").unwrap();
        assert!(connect(AiApp::Codex, &p, "/x").is_err());
        assert_eq!(std::fs::read_to_string(&toml).unwrap(), "[[[ nope");
    }

    #[test]
    fn disconnect_removes_only_cerebra() {
        let (_d, p) = paths();
        let file = target_file(AiApp::ClaudeDesktop, &p);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, r#"{"mcpServers":{"other":{"command":"x"}}}"#).unwrap();
        connect(AiApp::ClaudeDesktop, &p, "/x").unwrap();
        disconnect(AiApp::ClaudeDesktop, &p).unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert!(v["mcpServers"].get("cerebra").is_none());
        assert_eq!(v["mcpServers"]["other"]["command"], "x");
        assert!(!status(AiApp::ClaudeDesktop, &p));
        connect(AiApp::Codex, &p, "/x").unwrap();
        disconnect(AiApp::Codex, &p).unwrap();
        assert!(!status(AiApp::Codex, &p));
    }

    #[test]
    fn app_names_parse() {
        for n in ["claude_desktop", "claude_code", "codex", "cursor"] {
            assert!(AiApp::parse(n).is_some(), "{n}");
        }
        assert!(AiApp::parse("chatgpt_web").is_none());
    }
}
