//! The AI sources the agents may use, in the user's order (`<app data>/sources.json`).
//! Keys are NOT stored here: they live in the OS keychain (`keychain.rs`).

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub use crate::keychain::Keys;
#[cfg(test)]
pub use crate::keychain::MemoryKeys;

/// A provider Cerebra knows how to talk to (doc 06 §2).
#[derive(Debug, Clone, Serialize)]
pub struct Preset {
    pub provider: &'static str,
    pub label: &'static str,
    pub model: &'static str,
    pub base_url: Option<&'static str>,
    pub local: bool,
    pub needs_key: bool,
    pub free_tier: bool,
    /// Where to get a key (or the app to install, for local models).
    pub key_url: &'static str,
}

pub const PRESETS: &[Preset] = &[
    Preset {
        provider: "gemini",
        label: "Google Gemini",
        model: "gemini-2.5-flash",
        base_url: None,
        local: false,
        needs_key: true,
        free_tier: true,
        key_url: "https://aistudio.google.com/apikey",
    },
    Preset {
        provider: "groq",
        label: "Groq",
        model: "openai/gpt-oss-120b",
        base_url: Some("https://api.groq.com/openai/v1"),
        local: false,
        needs_key: true,
        free_tier: true,
        key_url: "https://console.groq.com/keys",
    },
    Preset {
        provider: "openrouter",
        label: "OpenRouter",
        model: "meta-llama/llama-3.3-70b-instruct:free",
        base_url: Some("https://openrouter.ai/api/v1"),
        local: false,
        needs_key: true,
        free_tier: true,
        key_url: "https://openrouter.ai/keys",
    },
    Preset {
        provider: "mistral",
        label: "Mistral",
        model: "mistral-small-latest",
        base_url: None,
        local: false,
        needs_key: true,
        free_tier: true,
        key_url: "https://console.mistral.ai/api-keys",
    },
    Preset {
        provider: "openai",
        label: "OpenAI",
        model: "gpt-4.1-mini",
        base_url: None,
        local: false,
        needs_key: true,
        free_tier: false,
        key_url: "https://platform.openai.com/api-keys",
    },
    Preset {
        provider: "anthropic",
        label: "Anthropic",
        model: "claude-haiku-5-5",
        base_url: None,
        local: false,
        needs_key: true,
        free_tier: false,
        key_url: "https://console.anthropic.com/settings/keys",
    },
    Preset {
        provider: "deepseek",
        label: "DeepSeek",
        model: "deepseek-chat",
        base_url: Some("https://api.deepseek.com/v1"),
        local: false,
        needs_key: true,
        free_tier: false,
        key_url: "https://platform.deepseek.com/api_keys",
    },
    Preset {
        provider: "openai_compatible",
        label: "Custom (OpenAI-compatible)",
        model: "",
        base_url: None,
        local: false,
        needs_key: true,
        free_tier: false,
        key_url: "",
    },
    Preset {
        provider: "ollama",
        label: "Ollama (on this computer)",
        model: "llama3.1:8b",
        base_url: Some("http://localhost:11434"),
        local: true,
        needs_key: false,
        free_tier: true,
        key_url: "https://ollama.com/download",
    },
    Preset {
        provider: "lmstudio",
        label: "LM Studio (on this computer)",
        model: "local-model",
        base_url: Some("http://localhost:1234/v1"),
        local: true,
        needs_key: false,
        free_tier: true,
        key_url: "https://lmstudio.ai",
    },
];

/// Does this URL point at this computer (so text sent there never leaves it)?
pub fn is_this_computer(url: &str) -> bool {
    let rest = url.split_once("://").map(|x| x.1).unwrap_or(url);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = if let Some(v6) = authority.strip_prefix('[') {
        v6.split(']').next().unwrap_or("")
    } else {
        authority.rsplit_once(':').map(|x| x.0).unwrap_or(authority)
    };
    matches!(
        host.to_ascii_lowercase().as_str(),
        "localhost" | "127.0.0.1" | "::1"
    )
}

pub fn preset(provider: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|p| p.provider == provider)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Caps {
    pub requests_per_day: Option<u64>,
    pub tokens_per_day: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Source {
    pub id: String,
    pub label: String,
    pub provider: String,
    pub model: String,
    pub base_url: Option<String>,
    pub enabled: bool,
    #[serde(default)]
    pub caps: Caps,
    pub local: bool,
    /// A key is stored in the keychain (the key itself never is here).
    #[serde(default)]
    pub has_key: bool,
}

/// What the UI sends to add or change a source (all optional except the provider).
#[derive(Debug, Clone, Deserialize)]
pub struct SourceInput {
    pub provider: String,
    pub model: Option<String>,
    pub base_url: Option<String>,
    pub label: Option<String>,
    pub caps: Option<Caps>,
    pub enabled: Option<bool>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Sources {
    pub list: Vec<Source>,
}

fn clean(s: Option<String>) -> Option<String> {
    s.map(|x| x.trim().to_string()).filter(|x| !x.is_empty())
}

impl Sources {
    pub fn load(file: &Path) -> Sources {
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

    fn build(input: SourceInput, id: String, has_key: bool, enabled: bool) -> Result<Source, String> {
        let p = preset(&input.provider).ok_or_else(|| format!("Unknown provider: {}", input.provider))?;
        let model = clean(input.model).unwrap_or_else(|| p.model.to_string());
        if model.is_empty() {
            return Err("Enter the model name".into());
        }
        let base_url = clean(input.base_url).or(p.base_url.map(String::from));
        if p.provider == "openai_compatible" && base_url.is_none() {
            return Err("Enter the service's base URL (it usually ends in /v1)".into());
        }
        if let Some(u) = &base_url
            && !(u.starts_with("https://") || u.starts_with("http://"))
        {
            return Err("The base URL must start with https:// or http://".into());
        }
        if p.needs_key && !has_key {
            return Err(format!("Paste your {} API key", p.label));
        }
        let local = p.local && base_url.as_deref().is_none_or(is_this_computer);
        Ok(Source {
            label: clean(input.label).unwrap_or_else(|| format!("{} · {model}", p.label)),
            provider: p.provider.into(),
            model,
            base_url,
            enabled: input.enabled.unwrap_or(enabled),
            caps: input.caps.unwrap_or_default(),
            local,
            has_key,
            id,
        })
    }

    pub fn add(
        &mut self,
        input: SourceInput,
        key: Option<&str>,
        keys: &mut dyn Keys,
    ) -> Result<Source, String> {
        let key = key.map(str::trim).filter(|k| !k.is_empty());
        let seed = format!(
            "{}{}{:?}",
            input.provider,
            self.list.len(),
            std::time::SystemTime::now()
        );
        let id = format!("s_{}", &hex::encode(Sha256::digest(seed.as_bytes()))[..10]);
        let source = Self::build(input, id.clone(), key.is_some(), true)?;
        if let Some(k) = key {
            keys.set(&id, k)?;
        }
        self.list.push(source.clone());
        Ok(source)
    }

    /// Change a source; `key` replaces the stored key when given.
    pub fn update(
        &mut self,
        id: &str,
        input: SourceInput,
        key: Option<&str>,
        keys: &mut dyn Keys,
    ) -> Result<Source, String> {
        let i = self
            .list
            .iter()
            .position(|s| s.id == id)
            .ok_or("Source not found")?;
        let key = key.map(str::trim).filter(|k| !k.is_empty());
        let old = &self.list[i];
        let merged = SourceInput {
            model: input.model.or(Some(old.model.clone())),
            base_url: input.base_url.or(old.base_url.clone()),
            label: input.label.or(Some(old.label.clone())),
            caps: input.caps.or(Some(old.caps.clone())),
            enabled: input.enabled.or(Some(old.enabled)),
            provider: old.provider.clone(),
        };
        let source = Self::build(merged, id.into(), old.has_key || key.is_some(), old.enabled)?;
        if let Some(k) = key {
            keys.set(id, k)?;
        }
        self.list[i] = source.clone();
        Ok(source)
    }

    /// The agents found the provider retired this source's model and switched to `model`.
    /// Returns whether anything changed. The label follows when it was the automatic one.
    pub fn set_model(&mut self, id: &str, model: &str) -> bool {
        let model = model.trim();
        let Some(src) = self.list.iter_mut().find(|s| s.id == id) else {
            return false;
        };
        if model.is_empty() || src.model == model {
            return false;
        }
        if let Some(p) = preset(&src.provider)
            && src.label == format!("{} · {}", p.label, src.model)
        {
            src.label = format!("{} · {model}", p.label);
        }
        src.model = model.to_string();
        true
    }

    pub fn remove(&mut self, id: &str, keys: &mut dyn Keys) -> Result<(), String> {
        let before = self.list.len();
        self.list.retain(|s| s.id != id);
        if self.list.len() == before {
            return Err("Source not found".into());
        }
        keys.delete(id)
    }

    /// Put the sources in this order (every id exactly once).
    pub fn reorder(&mut self, ids: &[String]) -> Result<(), String> {
        let mut sorted: Vec<&String> = ids.iter().collect();
        sorted.sort();
        sorted.dedup();
        if sorted.len() != self.list.len() || !self.list.iter().all(|s| ids.contains(&s.id)) {
            return Err("The new order must list every source once".into());
        }
        self.list.sort_by_key(|s| ids.iter().position(|i| *i == s.id));
        Ok(())
    }

    fn payload_where(
        &self,
        keys: &dyn Keys,
        usage: &[cerebra_core::jobs::Usage],
        local_only: bool,
    ) -> Vec<Value> {
        self.list
            .iter()
            .filter(|s| s.enabled && (!local_only || s.local))
            .map(|s| {
                let used = usage.iter().find(|u| u.source_id == s.id);
                json!({
                    "id": s.id,
                    "provider": s.provider,
                    "model": s.model,
                    "base_url": s.base_url,
                    "api_key": keys.get(&s.id).ok().flatten(),
                    "caps": s.caps,
                    "local": s.local,
                    "used_today": {
                        "requests": used.map(|u| u.requests).unwrap_or(0),
                        "tokens": used.map(|u| u.input_tokens + u.output_tokens).unwrap_or(0),
                    },
                })
            })
            .collect()
    }

    /// The enabled sources, in order, as the agents receive them (with keys, in memory only).
    pub fn payload(&self, keys: &dyn Keys, usage: &[cerebra_core::jobs::Usage]) -> Vec<Value> {
        self.payload_where(keys, usage, false)
    }

    /// Only sources running on this computer (for collections marked local-only).
    pub fn payload_local_only(&self, keys: &dyn Keys, usage: &[cerebra_core::jobs::Usage]) -> Vec<Value> {
        self.payload_where(keys, usage, true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(provider: &str) -> SourceInput {
        SourceInput {
            provider: provider.into(),
            model: None,
            base_url: None,
            label: None,
            caps: None,
            enabled: None,
        }
    }

    #[test]
    fn sources_round_trip_without_keys_in_file() {
        let d = tempfile::tempdir().unwrap();
        let file = d.path().join("sources.json");
        let mut keys = MemoryKeys::default();
        let mut s = Sources::load(&file);
        let a = s.add(input("gemini"), Some("AIzaSECRET123"), &mut keys).unwrap();
        assert_eq!(a.model, "gemini-2.5-flash", "preset default model");
        assert!(a.has_key && !a.local);
        let b = s.add(input("ollama"), None, &mut keys).unwrap();
        assert!(b.local && !b.has_key);
        s.save(&file).unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(!text.contains("SECRET"), "keys never in the file");
        let back = Sources::load(&file);
        assert_eq!(back.list.len(), 2);
        assert_eq!(keys.get(&a.id).unwrap().as_deref(), Some("AIzaSECRET123"));
        assert!(
            s.add(input("gemini"), None, &mut keys).is_err(),
            "cloud providers need a key"
        );
        assert!(s.add(input("nope"), Some("k"), &mut keys).is_err());
        assert!(
            s.add(input("openai_compatible"), Some("k"), &mut keys).is_err(),
            "needs a base URL"
        );
        let mut c = input("openai_compatible");
        c.base_url = Some("ftp://x".into());
        c.model = Some("m".into());
        assert!(s.add(c, Some("k"), &mut keys).is_err(), "http(s) only");
    }

    #[test]
    fn reorder_update_and_remove() {
        let d = tempfile::tempdir().unwrap();
        let mut keys = MemoryKeys::default();
        let mut s = Sources::load(&d.path().join("s.json"));
        let a = s.add(input("groq"), Some("gsk_1"), &mut keys).unwrap();
        let b = s.add(input("lmstudio"), None, &mut keys).unwrap();
        s.reorder(&[b.id.clone(), a.id.clone()]).unwrap();
        assert_eq!(s.list[0].id, b.id);
        assert!(
            s.reorder(std::slice::from_ref(&a.id)).is_err(),
            "must name every source"
        );
        s.update(
            &a.id,
            SourceInput {
                enabled: Some(false),
                ..input("groq")
            },
            Some("gsk_2"),
            &mut keys,
        )
        .unwrap();
        assert!(!s.list[1].enabled);
        assert_eq!(keys.get(&a.id).unwrap().as_deref(), Some("gsk_2"));
        s.remove(&a.id, &mut keys).unwrap();
        assert_eq!(s.list.len(), 1);
        assert_eq!(keys.get(&a.id).unwrap(), None, "key deleted with the source");
    }

    #[test]
    fn job_payload_has_enabled_sources_in_order_with_keys() {
        let d = tempfile::tempdir().unwrap();
        let mut keys = MemoryKeys::default();
        let mut s = Sources::load(&d.path().join("s.json"));
        let a = s.add(input("groq"), Some("gsk_1"), &mut keys).unwrap();
        let b = s.add(input("ollama"), None, &mut keys).unwrap();
        let c = s.add(input("gemini"), Some("g"), &mut keys).unwrap();
        s.update(
            &c.id,
            SourceInput {
                enabled: Some(false),
                ..input("gemini")
            },
            None,
            &mut keys,
        )
        .unwrap();
        let p = s.payload(&keys, &[]);
        let ids: Vec<&str> = p.iter().map(|x| x["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec![a.id.as_str(), b.id.as_str()]);
        assert_eq!(p[0]["api_key"], "gsk_1");
        assert_eq!(p[0]["base_url"], "https://api.groq.com/openai/v1");
        assert_eq!(p[1]["local"], true);
        let local_only = s.payload_local_only(&keys, &[]);
        assert_eq!(local_only.len(), 1);
    }

    #[test]
    fn local_providers_on_another_computer_are_not_local() {
        let d = tempfile::tempdir().unwrap();
        let mut keys = MemoryKeys::default();
        let mut s = Sources::load(&d.path().join("s.json"));
        let here = s
            .add(
                SourceInput {
                    base_url: Some("http://127.0.0.1:11434".into()),
                    ..input("ollama")
                },
                None,
                &mut keys,
            )
            .unwrap();
        assert!(here.local);
        let lan = s
            .add(
                SourceInput {
                    base_url: Some("http://192.168.1.20:11434".into()),
                    ..input("ollama")
                },
                None,
                &mut keys,
            )
            .unwrap();
        assert!(!lan.local, "notes sent to another machine leave this computer");
        assert!(is_this_computer("http://localhost:1234/v1") && is_this_computer("http://[::1]:1234"));
        assert!(!is_this_computer("https://localhost.evil.com/v1"));
    }

    #[test]
    fn a_replaced_model_is_saved_on_the_source() {
        let d = tempfile::tempdir().unwrap();
        let mut keys = MemoryKeys::default();
        let mut s = Sources::load(&d.path().join("s.json"));
        let a = s
            .add(
                SourceInput {
                    model: Some("llama-3.3-70b-versatile".into()),
                    ..input("groq")
                },
                Some("gsk_1"),
                &mut keys,
            )
            .unwrap();
        assert!(s.set_model(&a.id, "openai/gpt-oss-120b"));
        assert_eq!(s.list[0].model, "openai/gpt-oss-120b");
        assert!(
            s.list[0].label.contains("openai/gpt-oss-120b"),
            "{}",
            s.list[0].label
        );
        assert!(!s.set_model("nope", "x"));
        assert!(!s.set_model(&a.id, "  "));
    }
}
