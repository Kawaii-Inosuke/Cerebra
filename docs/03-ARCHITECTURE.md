# 03 · Architecture

## 1. The parts

```
┌──────────────────────────────── Cerebra (one install) ────────────────────────────────┐
│                                                                                        │
│  ┌──────────── UI (React) ────────────┐        ┌──────── cerebra-agents (Python) ────┐ │
│  │ Library · Graph · Note · Search    │        │ Strands Graph workflow              │ │
│  │ AI sources · Agents queue · Share  │        │  Reader → Linker → Judge → Writer   │ │
│  └──────────────┬─────────────────────┘        │ RotatingModel over all AI sources   │ │
│                 │ dispatch(cmd,args)           │ MCPClient ──┐                       │ │
│  ┌──────────────▼─────────────────────┐ stdio  └─────────────┼───────▲───────────────┘ │
│  │ cerebra-core (Rust)                │ JSON-RPC jobs/events │       │                 │
│  │ library · parse · resolve · graph  │◀─────────────────────┼───────┘                 │
│  │ store (SQLite/FTS5) · retrieve     │                      │ stdio MCP               │
│  │ upload · extract · OCR · semantic  │      ┌───────────────▼──────────┐              │
│  │ ai_layer · queue · share · sources │◀─────│ cerebra mcp (same binary) │◀── Claude    │
│  └──────────────┬─────────────────────┘      └──────────────────────────┘    Desktop,  │
│                 │                                                            Codex…    │
└─────────────────┼──────────────────────────────────────────────────────────────────────┘
                  ▼
   Library folder (your Markdown + Files/)  +  .cerebra/ (index.db, ai-layer.json, queue, settings)
                                    AI sources ◀── HTTPS ── agents (Gemini, Groq…) or localhost (Ollama…)
```

- **One Rust engine.** The UI, the CLI and the MCP server all call `cerebra_core::session::dispatch`, so
  they can never disagree.
- **Agents are a separate program** so Python and Strands stay isolated, can crash without taking the app
  down, and can be developed and tested on their own (`uv run cerebra-agents --dev`).
- **Agents use the MCP server as their tools.** The tools Claude Desktop uses are the tools the Strands agents
  use. Agent-only tools (e.g. `candidates_for`) are enabled with `--agent`.

## 2. Flows

### 2.1 Upload → connected
1. User drops `unit3.pdf` on the *Biology* collection.
2. Engine copies it to `Biology/Files/unit3.pdf`, extracts text (OCR where needed), writes `Biology/unit3.md`.
3. Watcher re-indexes: notes, links, chunks, FTS, embeddings.
4. Auto-connect is on → queue gets `connect_note(Biology/unit3.md)`.
5. Engine starts (or reuses) the sidecar and sends `run_job` with the job and the in-memory source list.
6. The Strands workflow (doc 06): Reader extracts key ideas → `candidates_for` finds related passages locally
   (no AI cost) → Linker proposes connections → Judge keeps the valuable ones → Writer calls
   `save_connections` (and maybe `save_concept_note`).
7. Engine writes them to the AI layer, emits `connection_saved`; the graph animates the new edges.

### 2.2 Rotation
Source 1 (Gemini free) returns 429 → RotatingModel marks it cooling for `Retry-After` → retries the same model
call on source 2 (Groq) → continues. The UI shows "Gemini resting 58 s, using Groq". If every source is cooling,
the job pauses until the earliest one is ready.

### 2.3 Claude Desktop
User clicks *Connect Claude Desktop* → Cerebra adds `{"cerebra": {"command": "<app>", "args": ["mcp"]}}` to
Claude's config (backup first). In Claude: "Using my Cerebra notes, how does osmosis relate to Unit 2?" →
`search` → `related` → `read_note` → answer. "Add this summary to Cerebra and connect it" → `add_note` +
`connect` (enqueues a job; the app's agents do it, or Claude saves connections itself with `save_connections`).

### 2.4 Topic
"Connect topic: *Photosynthesis*" (UI or MCP) → job `connect_topic` → Reader gathers passages via search →
Writer creates a concept note "Photosynthesis" in the AI layer → links to every note that genuinely covers it.

### 2.5 Share
Export *Biology* → `Biology.cerebra` (notes, files, AI connections, concept notes; no keys, no index). The
receiver double-clicks → choose a library → imported as a collection; index rebuilt locally.

## 3. Process lifetime

- The sidecar starts on the first job and exits after 5 idle minutes. One sidecar per app.
- `cerebra mcp` processes are started by the AI apps. They open the library read-mostly; writes (AI layer,
  queue, new notes) go through SQLite with WAL + a file lock on `ai-layer.json`, and the app picks up
  changes via the watcher.
- The app writes `connector.json` (last opened library) to the OS app-data folder so `cerebra mcp` knows
  which library to serve.

## 4. Code layout (repo)

```
crates/cerebra-core/   engine (clean-room link engine, index, search, uploads, OCR)
crates/cerebra-cli/    `cerebra` CLI and browser preview
src-tauri/             desktop shell, keychain, sidecar manager, connector setup, file association
ui/                    React app
agents/                Python package `cerebra_agents` (Strands), pyproject + uv.lock, tests
scripts/               fetch-models, build-sidecar
docs/                  these docs
fixtures/              test libraries
```
