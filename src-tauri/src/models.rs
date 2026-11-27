//! The local AI models (OCR, search by meaning, re-ranking): downloaded on first use into
//! `<app data>/models`, each file pinned to a SHA-256 (same list as `scripts/fetch-models.mjs`).

use std::io::Read;
use std::path::Path;

use sha2::{Digest, Sha256};

pub struct ModelFile {
    /// Path inside the models folder.
    pub path: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Ready,
    Missing,
}

/// ~135 MB in total.
pub const FILES: &[ModelFile] = &[
    ModelFile {
        path: "ocr/pp-ocrv6_small_det.onnx",
        url: "https://github.com/GreatV/oar-ocr/releases/download/v0.7.0/pp-ocrv6_small_det.onnx",
        sha256: "d73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e",
    },
    ModelFile {
        path: "ocr/pp-ocrv6_small_rec.onnx",
        url: "https://github.com/GreatV/oar-ocr/releases/download/v0.7.0/pp-ocrv6_small_rec.onnx",
        sha256: "5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634",
    },
    ModelFile {
        path: "ocr/ppocrv6_dict.txt",
        url: "https://github.com/GreatV/oar-ocr/releases/download/v0.7.0/ppocrv6_dict.txt",
        sha256: "b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d",
    },
    ModelFile {
        path: "embed/model_optimized.onnx",
        url: "https://huggingface.co/Qdrant/bge-small-en-v1.5-onnx-Q/resolve/aa8f8b060edb00e03bfdd08813a2949946c8ba55/model_optimized.onnx",
        sha256: "51f1bd0addd6e859e42c2c8021a5e5461385bb676a649f4b269aa445449f2431",
    },
    ModelFile {
        path: "embed/tokenizer.json",
        url: "https://huggingface.co/Qdrant/bge-small-en-v1.5-onnx-Q/resolve/aa8f8b060edb00e03bfdd08813a2949946c8ba55/tokenizer.json",
        sha256: "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
    },
    ModelFile {
        path: "embed/config.json",
        url: "https://huggingface.co/Qdrant/bge-small-en-v1.5-onnx-Q/resolve/aa8f8b060edb00e03bfdd08813a2949946c8ba55/config.json",
        sha256: "13582bcf2effc85b7bf3d3f5532e686bc1c9ce86bb009d10f0ec33cbe92299dd",
    },
    ModelFile {
        path: "embed/special_tokens_map.json",
        url: "https://huggingface.co/Qdrant/bge-small-en-v1.5-onnx-Q/resolve/aa8f8b060edb00e03bfdd08813a2949946c8ba55/special_tokens_map.json",
        sha256: "5d5b662e421ea9fac075174bb0688ee0d9431699900b90662acd44b2a350503a",
    },
    ModelFile {
        path: "embed/tokenizer_config.json",
        url: "https://huggingface.co/Qdrant/bge-small-en-v1.5-onnx-Q/resolve/aa8f8b060edb00e03bfdd08813a2949946c8ba55/tokenizer_config.json",
        sha256: "0b29c7bfc889e53b36d9dd3e686dd4300f6525110eaa98c76a5dafceb2029f53",
    },
    ModelFile {
        path: "rerank/model_int8.onnx",
        url: "https://huggingface.co/jinaai/jina-reranker-v1-turbo-en/resolve/b8c14f4e723d9e0aab4732a7b7b93741eeeb77c2/onnx/model_int8.onnx",
        sha256: "3defdef1ae34e119bd704216087743e79665934c96aebabcb6077c239dc3ae66",
    },
    ModelFile {
        path: "rerank/tokenizer.json",
        url: "https://huggingface.co/jinaai/jina-reranker-v1-turbo-en/resolve/b8c14f4e723d9e0aab4732a7b7b93741eeeb77c2/tokenizer.json",
        sha256: "0046da43cc8c424b317f56b092b0512aaaa65c4f925d2f16af9d9eeb4d0ef902",
    },
    ModelFile {
        path: "rerank/config.json",
        url: "https://huggingface.co/jinaai/jina-reranker-v1-turbo-en/resolve/b8c14f4e723d9e0aab4732a7b7b93741eeeb77c2/config.json",
        sha256: "e050ff6a15ae9295e84882fa0e98051bd8754856cd5201395ebf00ce9f2d609b",
    },
    ModelFile {
        path: "rerank/special_tokens_map.json",
        url: "https://huggingface.co/jinaai/jina-reranker-v1-turbo-en/resolve/b8c14f4e723d9e0aab4732a7b7b93741eeeb77c2/special_tokens_map.json",
        sha256: "06e405a36dfe4b9604f484f6a1e619af1a7f7d09e34a8555eb0b77b66318067f",
    },
    ModelFile {
        path: "rerank/tokenizer_config.json",
        url: "https://huggingface.co/jinaai/jina-reranker-v1-turbo-en/resolve/b8c14f4e723d9e0aab4732a7b7b93741eeeb77c2/tokenizer_config.json",
        sha256: "d291c6652d96d56ffdbcf1ea19d9bae5ed79003f7648c627e725a619227ce8fa",
    },
];

/// Ready when every file is present (checksums are verified when they are downloaded).
pub fn status(dir: &Path, files: &[ModelFile]) -> Status {
    if files.iter().all(|f| dir.join(f.path).is_file()) {
        Status::Ready
    } else {
        Status::Missing
    }
}

/// Check `bytes` against the pinned checksum and write the file atomically (`.part` + rename).
pub fn store(dir: &Path, file: &ModelFile, bytes: &[u8]) -> Result<(), String> {
    if hex::encode(Sha256::digest(bytes)) != file.sha256 {
        return Err(format!(
            "{} didn't match its expected checksum; not using it",
            file.path
        ));
    }
    let path = dir.join(file.path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let part = path.with_extension(format!(
        "{}.part",
        path.extension()
            .map(|e| e.to_string_lossy().into_owned())
            .unwrap_or_default()
    ));
    std::fs::write(&part, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&part, &path).map_err(|e| e.to_string())
}

/// Download every missing file. `progress(done, total)` is called after each file.
pub fn download(dir: &Path, files: &[ModelFile], progress: impl Fn(usize, usize)) -> Result<(), String> {
    let total = files.len();
    for (i, f) in files.iter().enumerate() {
        if !dir.join(f.path).is_file() {
            let mut bytes = Vec::new();
            ureq::get(f.url)
                .call()
                .map_err(|e| format!("Couldn't download {}: {e}", f.path))?
                .into_body()
                .into_reader()
                .read_to_end(&mut bytes)
                .map_err(|e| format!("Couldn't download {}: {e}", f.path))?;
            store(dir, f, &bytes)?;
        }
        progress(i + 1, total);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use sha2::{Digest, Sha256};

    use super::*;

    fn fake(path: &'static str, content: &[u8]) -> (ModelFile, Vec<u8>) {
        let sha: &'static str = Box::leak(hex::encode(Sha256::digest(content)).into_boxed_str());
        (
            ModelFile {
                path,
                url: "http://unused",
                sha256: sha,
            },
            content.to_vec(),
        )
    }

    #[test]
    fn models_status_missing_then_ready() {
        let d = tempfile::tempdir().unwrap();
        let (a, abytes) = fake("embed/a.onnx", b"aaa");
        let (b, bbytes) = fake("ocr/b.txt", b"bbb");
        let files = [a, b];
        assert_eq!(status(d.path(), &files), Status::Missing);
        store(d.path(), &files[0], &abytes).unwrap();
        assert_eq!(status(d.path(), &files), Status::Missing);
        store(d.path(), &files[1], &bbytes).unwrap();
        assert_eq!(status(d.path(), &files), Status::Ready);
    }

    #[test]
    fn wrong_checksum_is_refused_and_nothing_written() {
        let d = tempfile::tempdir().unwrap();
        let (a, _) = fake("embed/a.onnx", b"right");
        assert!(store(d.path(), &a, b"wrong").is_err());
        assert!(!d.path().join("embed/a.onnx").exists());
        assert!(!d.path().join("embed/a.onnx.part").exists());
    }

    #[test]
    fn pinned_list_matches_the_script() {
        let script = include_str!("../../scripts/fetch-models.mjs");
        for f in FILES {
            assert!(
                script.contains(f.sha256),
                "{} hash differs from the script",
                f.path
            );
            assert!(
                script.contains(&format!("\"{}\"", f.path)),
                "{} missing from the script",
                f.path
            );
        }
        assert_eq!(
            FILES.len(),
            script
                .lines()
                .filter(|l| l.trim_start().starts_with("[\""))
                .count()
        );
    }
}
