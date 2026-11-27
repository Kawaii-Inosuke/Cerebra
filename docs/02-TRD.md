# 02 · TRD: Technical Requirements

## 1. Stack

| Layer | Choice | Notes |
|---|---|---|
| Desktop shell | **Tauri 2** | Windows 10+, macOS 12+ (Apple Silicon; Intel without local ML models), Linux (WebKitGTK 4.1) |
| Engine | **Rust** (edition 2024), crate `cerebra-core` | Library loading, links, graph, store, search, uploads, OCR, AI layer, MCP server, share files |
| CLI | crate `cerebra-cli` (`cerebra`) | Inspect a library, browser preview, run the MCP server, run agent jobs headless |
| Screens | **React 19 + TypeScript + Vite**, Tailwind CSS v4, Radix UI primitives, `cmdk`, Lucide icons | Graph: d3-force on a canvas |
| Agents | **Python 3.12 + Strands Agents** (`strands-agents` ≥ 1.67) in `agents/` | Bundled as a single sidecar binary with PyInstaller per OS; managed with `uv` |
| Store | **SQLite** (rusqlite, bundled) + FTS5 | One index per library in `.cerebra/index.db` |
| Local ML | ONNX Runtime via `fastembed` + PaddleOCR | BGE-small-en v1.5 (embeddings), Jina reranker v1 turbo, PP-OCRv6 small; ~135 MB, downloaded on first use with SHA-256 checks |
| Secrets | OS keychain via `keyring` | API keys never written to files |
| Share files | zip (`zip` crate) + optional `age` passphrase encryption | doc 09 |

## 2. Functional requirements

### Library
- R1 Open or create a library folder. Each top-level folder is a **collection**; root-level notes belong to "Inbox".
- R2 Watch the folder; re-index changed files within 2 s (debounced); never edit user files except on explicit
  user action (editor save, upload, accepting an AI note as a real note).
- R3 Obsidian compatibility for `[[links]]`, embeds, aliases, tags, headings, block ids (doc 05).

### Upload
- R4 Accept .pdf .docx .pptx .md .txt .png .jpg .jpeg .webp. Originals go to `<collection>/Files/`; a Markdown
  note with the extracted text is created next to them (`<name>.md`, frontmatter `source: Files/<file>`).
- R5 Scanned PDF pages and images are OCR'd locally. Upload of 100 pages finishes in < 60 s on a mid laptop.

### Search
- R6 Hybrid retrieval: note-name matching, FTS5 keywords, embeddings, merged and re-ranked; < 300 ms for
  10k chunks.

### AI sources and rotation
- R7 Unlimited sources, each: provider, model id, base URL (when relevant), key (keychain), daily request /
  token caps, enabled flag, order.
- R8 Supported: Gemini, Groq, OpenRouter, OpenAI, Anthropic, Mistral, DeepSeek, any OpenAI-compatible URL,
  Ollama, LM Studio, llama.cpp server.
- R9 "Test" button per source: one tiny call; shows latency, model and error in plain words.
- R10 Rotation on rate limit (HTTP 429 / `ModelThrottledException`), quota exhausted, auth failure, timeout,
  5xx. Rate-limited sources cool down (`Retry-After` if given, else 60 s, doubling to 15 min). Auth failures
  disable the source until the user fixes it. Spec: doc 06 §5.

### Agents
- R11 A persistent **job queue** (SQLite) of connect jobs: note, collection, topic. Survives restarts.
- R12 Auto-enqueue on upload / new or changed note (when "Auto-connect" is on).
- R13 The workflow (doc 06) saves connections with: from, to, type, reason, evidence quotes, confidence,
  source model, created at. Concept notes may be created in the AI layer.
- R14 Pause / resume / cancel; progress per job; costs (tokens) per source per day.
- R15 Without any enabled source, the app works fully except the agents; the queue waits.

### Connector
- R16 `cerebra mcp` runs an MCP server over stdio (doc 07). One-click setup for Claude Desktop, Claude Code,
  Codex, Cursor, with config backup.
- R17 MCP tools can enqueue agent jobs and save connections; the app shows them live.

### Share files
- R18 Export / import `.cerebra` (doc 09). Double-click opens Cerebra (file association).

### Version 2 (planned)
- R19 **Guided tutorial**: an overlay that highlights one real UI element at a time (anchored to stable `data-tour` attributes), with Next / Back / Skip, progress saved in the app settings, and steps that complete themselves when the user does the action (e.g. the step "Upload a file" completes on the first upload). Startable from Settings → Help and from the command palette. Works offline, keyboard accessible, respects reduced motion. Optional sample library (`fixtures/libraries/biology-small`) for users without material. *Status 0.1.0:* built in `ui/src/components/Tour.tsx` and `ui/src/lib/tour.ts`; seen/skipped is saved in the webview's local storage (`cerebra.tour`). Self-completing steps and the sample library are still to do.

## 3. Non-functional requirements

| | Requirement |
|---|---|
| Size | Installer ≤ 160 MB (app + agent sidecar, which includes Strands' required `boto3`); ML models downloaded on first use. Sidecar extras limited to `gemini`, `openai`, `anthropic`, `ollama`, `mistral` (no `litellm`) to keep it small |
| Memory | Idle ≤ 200 MB; indexing 5k notes ≤ 600 MB |
| Startup | Window in < 1.5 s; library of 5k notes indexed incrementally in background |
| Offline | Everything except remote AI sources works offline |
| Privacy | No telemetry. No network calls except: chosen AI sources, model downloads, update check (can be off) |
| Accessibility | Keyboard reachable everything; WCAG AA contrast in both themes; reduced-motion respected |
| Quality | `cargo test`, `pytest`, `vitest` in CI on all 3 OSes; clippy + ruff + eslint clean |

## 4. Interfaces between parts

| From → To | How |
|---|---|
| UI → engine | Tauri command `dispatch(cmd, args)` → `cerebra_core::session::dispatch` (same API in browser preview over HTTP) |
| Engine → agents | Spawns sidecar `cerebra-agents` (stdio, newline-delimited JSON-RPC 2.0). Methods: `run_job`, `cancel`, `test_source`, `shutdown`. Events back: `progress`, `connection_saved`, `source_status`, `usage`, `job_done` |
| Agents → engine | The sidecar is an **MCP client** of `cerebra mcp --agent` (same tools the AI apps use, plus agent-only tools). One tool surface for both |
| AI apps → engine | `cerebra mcp` over stdio |
| Secrets | Engine reads keys from the keychain and passes them to the sidecar **in memory** inside `run_job` / `test_source` (never env vars or files) |

## 5. Dependencies policy

Permissive licences only (MIT, Apache-2.0, BSD, ISC, Zlib, MPL-2.0 for unmodified use). `cargo deny` and
`pip-licenses` run in CI. All third-party notices in `THIRD-PARTY-NOTICES.md`.
