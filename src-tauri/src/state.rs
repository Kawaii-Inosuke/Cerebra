//! What the app remembers between runs, in `<app data>/app.json`: the open library and
//! recently opened ones. No secrets.

use std::path::Path;

use serde::{Deserialize, Serialize};

const MAX_RECENT: usize = 8;
/// Text and interface size: a little larger than the webview's 100% by default.
pub const DEFAULT_ZOOM: f64 = 1.15;

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    pub library: Option<String>,
    pub recent: Vec<String>,
    /// Interface zoom chosen by the user (`None` = default).
    pub zoom: Option<f64>,
}

impl AppSettings {
    /// Settings from `file`, or defaults if it's missing or unreadable.
    pub fn load(file: &Path) -> AppSettings {
        std::fs::read_to_string(file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, file: &Path) -> Result<(), String> {
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(file, serde_json::to_string_pretty(self).unwrap()).map_err(|e| e.to_string())
    }

    pub fn zoom(&self) -> f64 {
        self.zoom.unwrap_or(DEFAULT_ZOOM)
    }

    pub fn set_zoom(&mut self, z: f64) {
        self.zoom = Some((z.clamp(0.8, 1.6) * 100.0).round() / 100.0);
    }

    /// Make `library` the open one and move it to the front of the recent list.
    pub fn remember(&mut self, library: &str) {
        self.library = Some(library.to_string());
        self.recent.retain(|r| r != library);
        self.recent.insert(0, library.to_string());
        self.recent.truncate(MAX_RECENT);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_round_trip_and_recent_capped_at_8() {
        let d = tempfile::tempdir().unwrap();
        let file = d.path().join("app.json");
        let mut s = AppSettings::load(&file);
        assert_eq!(s.library, None);
        for i in 0..10 {
            s.remember(&format!("/lib{i}"));
        }
        s.remember("/lib3");
        s.save(&file).unwrap();
        let back = AppSettings::load(&file);
        assert_eq!(back.library.as_deref(), Some("/lib3"));
        assert_eq!(back.recent.len(), 8);
        assert_eq!(back.recent[0], "/lib3");
        assert_eq!(back.recent.iter().filter(|r| *r == "/lib3").count(), 1);
    }

    #[test]
    fn corrupt_file_loads_defaults() {
        let d = tempfile::tempdir().unwrap();
        let file = d.path().join("app.json");
        std::fs::write(&file, "{not json").unwrap();
        assert_eq!(AppSettings::load(&file).recent.len(), 0);
    }

    #[test]
    fn zoom_defaults_larger_and_is_clamped() {
        let d = tempfile::tempdir().unwrap();
        let file = d.path().join("app.json");
        std::fs::write(&file, r#"{"library":null,"recent":[]}"#).unwrap();
        let mut s = AppSettings::load(&file);
        assert_eq!(s.zoom(), DEFAULT_ZOOM);
        s.set_zoom(9.0);
        assert_eq!(s.zoom(), 1.6);
        s.set_zoom(0.1);
        assert_eq!(s.zoom(), 0.8);
        s.set_zoom(1.25);
        s.save(&file).unwrap();
        assert_eq!(AppSettings::load(&file).zoom(), 1.25);
    }
}
