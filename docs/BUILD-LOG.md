# Build log: Cerebra 0.1.0

How the first version of Cerebra was planned, built, tested and reviewed (November 26–27, 2026). For the
reasoning behind individual choices see [`DECISIONS.md`](../DECISIONS.md); for the design see the other docs
in this folder.

## 1. The idea

A free, open-source desktop app for **students and professionals**:

1. Add material (notes, PDFs, Word, PowerPoint, scans) to a **library**, which is just a folder.
2. Connect an AI: one or more **API keys** (free tiers like Gemini or Groq, or paid ones), or a model on your own
   computer (Ollama, LM Studio). If one key hits its limit, the next one takes over.
3. A **Strands Agents** workflow reads the material and saves only **valuable connections** between ideas,
   each with a type, a reason and quotes from both notes.
4. Use it like a database from **Claude Desktop / Claude Code / Codex / Cursor** (MCP connector, desktop only).
5. Share a topic as a **`.cerebra` file**; no accounts, no sync, nothing to host.

Ground rules: **zero cost** to run or use, **MIT licence**, everything stays on the user's computer, and the
link engine is clean-room (never derived from Obsidian's code).

## 2. Name, licence, logo

- **Name:** Cerebra (from *cerebrum*); share files are `.cerebra`.
- **Licence:** MIT.
- **Logo:** a black rounded square with a white network of six connected nodes. It was drawn as a vector
  (`src-tauri/icons/icon.svg`) and used for every app icon size, the in-app mark and the favicon. Violet
  stays the UI accent and means "AI did this".

## 3. Planning

The docs were written first (`docs/01` to `12`): PRD, TRD, architecture, data model, link engine, agents,
connector, security, share files, screens and design, roadmap and open source. A reviewer read them as a
builder would, and its questions were answered in the docs before any code was written. The work then
followed five phases, each with a written plan, test-first development and a progress log.

| Phase | What was built |
|---|---|
| 0: Engine | Rust `cerebra-core`: library loading, `[[links]]`, backlinks and graph, collections (top-level folders), SQLite full-text index, search by meaning and re-ranking with local models, context packs, uploads with OCR, Obsidian import; `cerebra` CLI |
| 1: Desktop app | Tauri shell, model download on first use, file watcher, `cerebrafile://` protocol, browser preview server; React UI: Home, Graph, Note (reader + editor), collections, command palette, uploads, settings, light/dark |
| 2: AI | AI layer (typed connections, verified quotes, concepts, review); durable job queue; MCP server; Python agents sidecar (Strands Graph: reader → scout → linker → judge → writer → concept; `RotatingModel` key rotation); AI sources with keychain storage; job runner with auto-connect; AI sources, Agents and Review screens |
| 3: Connector | One-click setup for Claude Desktop, Claude Code, Codex and Cursor (config backed up, other servers untouched); Copy context |
| 4: Share files | `.cerebra` export/import with an optional password (age), safe import, file association |
| 5: Release | CI (engine, agents, UI, desktop), release workflow (installers for Windows/macOS/Linux on a version tag, SHA-256 sums, SignPath step ready), code-signing policy, sample library + evaluation labels |

## 4. How it fits together

```
React UI ──dispatch──▶ cerebra-core (Rust)  ◀──stdio MCP── Claude Desktop / Codex / Cursor
                           ▲        ▲
                     job queue   MCP tools (--agent)
                           │        │
Tauri shell ──JSON-RPC──▶ cerebra-agents (Python + Strands) ──HTTPS──▶ Gemini, Groq, … or a local model
```

The keys live in the OS keychain and only reach the agents program in memory. AI connections are stored
in `<library>/.cerebra/ai-layer.json`, apart from the user's notes, which are never edited by AI.

## 5. Testing

- **Automated:** about 270 tests (engine and CLI, desktop shell, agents, UI), all passing, with fmt,
  clippy, ruff and eslint clean.
- **End to end:** the real agents binary, the real MCP tools and a real library, driven by a scripted
  model. One connection was saved, its quotes were verified, and the key never appeared in logs.
- **Real AI (Groq free tier).** This found and fixed:
  - a retired default model: Cerebra now asks the provider for its current models and switches automatically
  - provider-side format rejections wrongly resting the key: now retried once, then only that step is skipped
  - judge answers without rubric scores: now accepted cautiously
  - short rate limits (≤ 20 s): now waited out instead of pausing the job

  Result before the free key ran out: 11 connections, 6 matching the hand-made list and most of the rest
  sensible.

## 6. Independent review before release

A fresh reviewer read the whole repository. Everything it rated critical or important was fixed, each with a
test that failed first:

- **Critical:** local-only collections could reach a cloud AI through search. The tools now exclude them for
  cloud jobs.
- **Important:**
  - side processes requeued the running job
  - the keychain was read every 1.5 s
  - a console window appeared on Windows
  - the AppImage path broke the connector configs
  - the browser preview was open to cross-site requests
  - the limits on AI apps were too loose
  - an unreadable folder blocked opening a library
  - clicking a note link could open programs
- **Smaller:**
  - remote "local" models counted as local
  - the usage meter showed per-call numbers
  - share files had no decompression limit

## 7. Changes after trying the app

- Text is about 15% larger by default, adjustable in Settings → Appearance or with Ctrl + / − / 0.
- Library picker in the sidebar header and on the Graph page ("which vault am I looking at").
- The welcome screen is just three plain choices: *Start a new library*, *Use a folder I already have*,
  *Open notes someone shared*. Choosing one goes straight into the app. A guided tutorial is planned for
  version 2 (PRD §7a, TRD R19).
- The theme switch stays in Settings → Appearance.

## 8. Known limits (next steps)

- **Connection quality:**
  - some models skip the judge's scores
  - the same pair can be saved twice with different types
  - target precision is ≥ 80% (the first real run scored 55% against a strict list)
- **Large libraries:** reloads happen while the library is locked.
- **Sources:**
  - changing a source's address keeps its key
  - `http://` is accepted for paid services
- **Not built yet:**
  - the encrypted-file keychain fallback on Linux
  - double-click opening of `.cerebra` files on macOS
  - an "estimate first" prompt before auto-connecting a large import
- **Not tested yet:** Windows and macOS builds (CI builds them; they need a hands-on check).

## 9. After 0.1.0 (November 27, 2026)

- **CI fix:** "Desktop shell (Linux)" failed to link (`__isoc23_strtol`, `_M_replace_cold` undefined)
  because the prebuilt ONNX Runtime needs glibc 2.38 / GCC 13, and that job ran on Ubuntu 22.04. The
  desktop and release Linux jobs now run on 24.04.
- **Versioning:** one command sets the version everywhere, and CI and the Release workflow check it.
- **About Cerebra** window and the first **guided tour**. Details: [roadmap](11-ROADMAP.md), "Added before the first release".
- **Publishing guide:** [RELEASING.md](RELEASING.md), covering the licence, the Microsoft Store MSIX and
  SignPath.

## 10. Releasing

One repository is enough: versions are git tags (`v0.1.0`, `v0.2.0`, …), and pushing a tag makes the release
workflow build the installers into a draft GitHub Release. See `docs/12-OPEN-SOURCE.md` §5 for signing and
first-launch notes.
