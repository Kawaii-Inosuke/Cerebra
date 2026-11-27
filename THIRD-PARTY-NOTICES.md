# Third-party notices

Cerebra's own code is MIT-licensed (see `LICENSE`). It uses the following third-party work, each under its own
licence.

## Local AI models (downloaded by `scripts/fetch-models.mjs`, not stored in this repository)

| Model | Use | Licence | Source |
|---|---|---|---|
| PaddleOCR PP-OCRv6 small (detection, recognition, dictionary) | Reading text from scans and pictures | Apache-2.0 | PaddleOCR, via the `oar-ocr` project's releases |
| BGE-small-en v1.5 (quantized ONNX) | Search by meaning | MIT | BAAI, quantized by Qdrant |
| Jina reranker v1 turbo en (int8 ONNX) | Re-ranking search results | Apache-2.0 | Jina AI |

## Rust libraries (direct dependencies)

| Crate | Licence |
|---|---|
| ammonia | MIT OR Apache-2.0 |
| anyhow | MIT OR Apache-2.0 |
| clap | MIT OR Apache-2.0 |
| comrak | BSD-2-Clause |
| fastembed | Apache-2.0 |
| hex | MIT OR Apache-2.0 |
| image | MIT OR Apache-2.0 |
| lopdf | MIT |
| oar-ocr | Apache-2.0 |
| pdf-extract | MIT |
| regex | MIT OR Apache-2.0 |
| rusqlite (bundles SQLite, public domain) | MIT |
| serde, serde_json | MIT OR Apache-2.0 |
| serde_yaml_ng | MIT |
| sha2 | MIT OR Apache-2.0 |
| thiserror | MIT OR Apache-2.0 |
| walkdir | Unlicense OR MIT |
| zip | MIT |

ONNX Runtime (MIT, Microsoft) is downloaded at build time by the `ort` crate. All transitive Rust dependencies
use permissive licences (MIT, Apache-2.0, BSD, ISC, Zlib, Unicode, MPL-2.0, BSL-1.0, CDLA-Permissive-2.0);
`cargo metadata` lists them. A generated full list will replace this table once release builds exist.
