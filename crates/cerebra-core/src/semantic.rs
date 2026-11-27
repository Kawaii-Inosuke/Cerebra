//! Search by meaning, all on this computer (fastembed-rs, Apache-2.0):
//! - **embeddings**: BGE-small-en v1.5 (quantized, MIT) turns each passage and each question
//!   into 384 numbers; passages whose numbers are close to the question's mean the same thing,
//!   even with different words;
//! - **re-ranking**: Jina reranker v1 turbo (int8, Apache-2.0) reads the question together
//!   with each candidate passage and scores how well it answers it.
//!
//! Passage vectors are cached in memory by a hash of the passage, computed in the background
//! (`warm`), and saved by the caller (`export` / `import`) to `.cerebra/vectors.bin` in the
//! library. Without models (tests, Intel Macs) everything here is simply unavailable and
//! search uses keywords only.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex, OnceLock};

use sha2::{Digest, Sha256};

static MODELS_DIR: OnceLock<PathBuf> = OnceLock::new();
static CACHE: LazyLock<Mutex<HashMap<[u8; 16], Vec<f32>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static WARMING: AtomicBool = AtomicBool::new(false);

/// BGE models expect this in front of search queries (not in front of passages).
const QUERY_PREFIX: &str = "Represent this sentence for searching relevant passages: ";
/// Passages are cut to this many characters before embedding / re-ranking (the models read
/// at most 512 tokens; shorter is faster).
pub const PASSAGE_CHARS: usize = 1500;
const RERANK_CHARS: usize = 900;

/// The folder that holds `embed/` and `rerank/`. Call once at startup.
pub fn set_models_dir(dir: PathBuf) {
    let _ = MODELS_DIR.set(dir);
}

/// Stable key for a passage: what's embedded is title + heading + text.
pub fn passage_key(text_for_embedding: &str) -> [u8; 16] {
    let h = Sha256::digest(text_for_embedding.as_bytes());
    let mut k = [0u8; 16];
    k.copy_from_slice(&h[..16]);
    k
}

/// The text that gets embedded for a passage.
pub fn passage_text(title: &str, heading_path: &str, text: &str) -> String {
    let t: String = text.chars().take(PASSAGE_CHARS).collect();
    if heading_path.is_empty() || heading_path == title {
        format!("{title}\n{t}")
    } else {
        format!("{heading_path}\n{t}")
    }
}

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
mod engine {
    use std::sync::{Mutex, OnceLock};

    use fastembed::{
        InitOptionsUserDefined, Pooling, RerankInitOptionsUserDefined, TextEmbedding, TextRerank,
        TokenizerFiles, UserDefinedEmbeddingModel, UserDefinedRerankingModel,
    };

    use super::MODELS_DIR;

    static EMBED: OnceLock<Option<Mutex<TextEmbedding>>> = OnceLock::new();
    static RERANK: OnceLock<Option<Mutex<TextRerank>>> = OnceLock::new();

    fn tokenizer(dir: &std::path::Path) -> Option<TokenizerFiles> {
        let r = |f: &str| std::fs::read(dir.join(f)).ok();
        Some(TokenizerFiles {
            tokenizer_file: r("tokenizer.json")?,
            config_file: r("config.json")?,
            special_tokens_map_file: r("special_tokens_map.json")?,
            tokenizer_config_file: r("tokenizer_config.json")?,
        })
    }

    pub fn embedder() -> Option<&'static Mutex<TextEmbedding>> {
        EMBED
            .get_or_init(|| {
                let dir = MODELS_DIR.get()?.join("embed");
                let onnx = std::fs::read(dir.join("model_optimized.onnx")).ok()?;
                let model = UserDefinedEmbeddingModel::new(onnx, tokenizer(&dir)?).with_pooling(Pooling::Cls);
                std::panic::catch_unwind(|| {
                    TextEmbedding::try_new_from_user_defined(model, InitOptionsUserDefined::default())
                })
                .ok()?
                .map_err(|e| eprintln!("Search by meaning unavailable: {e}"))
                .ok()
                .map(Mutex::new)
            })
            .as_ref()
    }

    pub fn reranker() -> Option<&'static Mutex<TextRerank>> {
        RERANK
            .get_or_init(|| {
                let dir = MODELS_DIR.get()?.join("rerank");
                let onnx = std::fs::read(dir.join("model_int8.onnx")).ok()?;
                let model = UserDefinedRerankingModel::new(onnx, tokenizer(&dir)?);
                std::panic::catch_unwind(|| {
                    TextRerank::try_new_from_user_defined(model, RerankInitOptionsUserDefined::default())
                })
                .ok()?
                .map_err(|e| eprintln!("Re-ranking unavailable: {e}"))
                .ok()
                .map(Mutex::new)
            })
            .as_ref()
    }

    pub fn embed(texts: &[String]) -> Option<Vec<Vec<f32>>> {
        let mut e = embedder()?.lock().ok()?;
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| e.embed(texts, Some(16))))
            .ok()?
            .ok()
    }

    pub fn rerank(query: &str, docs: &[String]) -> Option<Vec<f32>> {
        let mut r = reranker()?.lock().ok()?;
        let refs: Vec<&str> = docs.iter().map(String::as_str).collect();
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            r.rerank(query, refs, false, Some(16))
        }))
        .ok()?
        .ok()?;
        let mut scores = vec![f32::MIN; docs.len()];
        for x in res {
            if let Some(s) = scores.get_mut(x.index) {
                *s = x.score;
            }
        }
        Some(scores)
    }
}

/// True when the embedding model can be loaded (loads it the first time).
pub fn available() -> bool {
    #[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
    {
        engine::embedder().is_some()
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        false
    }
}

/// Without loading anything: are the model files there?
pub fn configured() -> bool {
    cfg!(not(all(target_os = "macos", target_arch = "x86_64")))
        && MODELS_DIR
            .get()
            .is_some_and(|d| d.join("embed").join("model_optimized.onnx").is_file())
}

fn embed(texts: &[String]) -> Option<Vec<Vec<f32>>> {
    #[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
    {
        engine::embed(texts)
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        let _ = texts;
        None
    }
}

/// The question's vector.
pub fn embed_query(q: &str) -> Option<Vec<f32>> {
    if !configured() {
        return None;
    }
    embed(&[format!("{QUERY_PREFIX}{}", q.trim())])?
        .into_iter()
        .next()
}

/// Cached vectors for these passage keys (missing ones are left out).
pub fn vectors_for(keys: &[[u8; 16]]) -> HashMap<[u8; 16], Vec<f32>> {
    let cache = CACHE.lock().expect("vector cache");
    keys.iter()
        .filter_map(|k| cache.get(k).map(|v| (*k, v.clone())))
        .collect()
}

/// How well each passage answers the question (higher = better), or `None` without a model.
pub fn rerank(query: &str, passages: &[String]) -> Option<Vec<f32>> {
    if !configured() || passages.is_empty() {
        return None;
    }
    let docs: Vec<String> = passages
        .iter()
        .map(|p| p.chars().take(RERANK_CHARS).collect())
        .collect();
    #[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
    {
        engine::rerank(query, &docs)
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        let _ = (query, docs);
        None
    }
}

pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    // BGE vectors come normalised, so the dot product is the cosine.
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// Compute vectors for passages not in the cache yet, on a background thread, then hand the
/// whole cache to `save` (to keep it for next time). Only one warm-up runs at a time; a later
/// call simply catches up whatever is still missing.
pub fn warm(passages: Vec<String>, save: Box<dyn FnOnce(Vec<u8>) + Send>) {
    if !configured() {
        return;
    }
    let missing: Vec<String> = {
        let cache = CACHE.lock().expect("vector cache");
        let mut seen = std::collections::HashSet::new();
        passages
            .into_iter()
            .filter(|p| {
                let k = passage_key(p);
                !cache.contains_key(&k) && seen.insert(k)
            })
            .collect()
    };
    if missing.is_empty() || WARMING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        for batch in missing.chunks(64) {
            match embed(batch) {
                Some(vs) => {
                    let mut cache = CACHE.lock().expect("vector cache");
                    for (p, v) in batch.iter().zip(vs) {
                        cache.insert(passage_key(p), v);
                    }
                }
                None => break,
            }
        }
        WARMING.store(false, Ordering::SeqCst);
        save(export());
    });
}

/// True while passages are still being prepared.
pub fn warming() -> bool {
    WARMING.load(Ordering::SeqCst)
}

const MAGIC: &[u8; 8] = b"CRBRVEC1";

/// The cache as bytes: magic, then per entry 16-byte key + 384 little-endian f32.
pub fn export() -> Vec<u8> {
    let cache = CACHE.lock().expect("vector cache");
    let mut out = Vec::with_capacity(8 + cache.len() * (16 + 384 * 4));
    out.extend_from_slice(MAGIC);
    for (k, v) in cache.iter() {
        if v.len() != 384 {
            continue;
        }
        out.extend_from_slice(k);
        for x in v {
            out.extend_from_slice(&x.to_le_bytes());
        }
    }
    out
}

/// Load a saved cache (ignores anything damaged).
pub fn import(bytes: &[u8]) {
    if bytes.len() < 8 || &bytes[..8] != MAGIC {
        return;
    }
    let rec = 16 + 384 * 4;
    let mut cache = CACHE.lock().expect("vector cache");
    for r in bytes[8..].chunks_exact(rec) {
        let mut k = [0u8; 16];
        k.copy_from_slice(&r[..16]);
        let v: Vec<f32> = r[16..]
            .as_chunks::<4>()
            .0
            .iter()
            .map(|b| f32::from_le_bytes(*b))
            .collect();
        cache.entry(k).or_insert(v);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_round_trips_and_ignores_junk() {
        let k = passage_key("A › B\ntext");
        CACHE.lock().unwrap().insert(k, vec![0.5; 384]);
        let bytes = export();
        CACHE.lock().unwrap().remove(&k);
        import(b"junk");
        import(&bytes);
        assert_eq!(vectors_for(&[k]).get(&k).map(|v| v[0]), Some(0.5));
        assert_eq!(passage_text("T", "T › Page 2", "hi"), "T › Page 2\nhi");
    }
}
