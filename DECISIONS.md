# Decisions

Design decisions made while building Cerebra, newest last. The design docs (`docs/`) describe the plan;
this file records what was decided and why.

| # | Date | Decision | Why |
|---|---|---|---|
| D1 | 2026-11-26 | Name **Cerebra**; share files use `.cerebra` | Short, brain-like, no existing notes app with the name |
| D2 | 2026-11-26 | **MIT** licence | Simplest for students, schools and companies |
| D3 | 2026-11-26 | Agents use **Strands Agents (Python)** in a bundled sidecar; key rotation via a custom `RotatingModel` | Reference Strands SDK with the most providers; users never install Python |
| D4 | 2026-11-26 | **No sync or accounts**; sharing by exporting `.cerebra` files | Shared storage is too hard to set up for non-technical users |
| D5 | 2026-11-26 | **Zero cost**: no paid services; Windows signed via free open-source programs (SignPath Foundation, Microsoft Store MSIX); macOS unsigned with first-launch steps | The project must cost nothing to run or use |
| D6 | 2026-11-26 | A **collection** is any top-level folder of the library, named exactly as the folder; root notes belong to none | Matches how people already organise folders; no config needed |
| D7 | 2026-11-26 | Uploads: originals in `<collection>/Files/`, the note next to them with `source: Files/<name>` | The note sits with the collection's other notes; originals stay tidy |
| D8 | 2026-11-26 | Importing into an existing collection name is refused (never merged) | Nothing of the user's is ever overwritten |
| D9 | 2026-11-26 | Model setters (`semantic`, `ocr`) both take the models **root** folder | One path for callers; OCR looks in `ocr/` itself |
| D10 | 2026-11-26 | AI layer and MCP connector are written fresh in Phases 2–3 for their new formats | The new connection format (types, reasons, evidence) differs from a simple link list |
| D11 | 2026-11-26 | The search index lives in `.cerebra/index.db` (rebuildable); jobs, note state and usage in `.cerebra/state.db` | Deleting the index must never lose work |
| D12 | 2026-11-26 | `cerebra mcp` keeps its index in memory and reloads on file changes | The app and an AI app's connector run side by side without fighting over one file |
| D13 | 2026-11-26 | AI-app saves are always recorded as `assistant` with the app's name; only Cerebra's agents (`--agent`) save as `agent` | Clear provenance in Review |
| D14 | 2026-11-26 | Quotes are verified against both notes before any AI connection is saved (exact, or ≥ 90% of words for quotes of 5+ words) | The main guard against invented connections |
| D15 | 2026-11-26 | Agents run one job at a time; a rate-limited source cools down (Retry-After, else 60 s doubling to 15 min) and the next source takes the call | Free tiers run out; work shouldn't stop |
| D16 | 2026-11-26 | Model downloads happen on first use; after a download the app offers a restart | Keeps the installer small; the engine loads models once |
| D17 | 2026-11-26 | Share files contain no keys, index, settings, usage, absolute paths or job ids; AI sources reduced to the provider name | Privacy when sharing |
| D18 | 2026-11-26 | Logo: black rounded square with a white network of six connected nodes (maintainer's design); vector master in `src-tauri/icons/icon.svg`. Violet stays the UI accent for "AI did this" | Chosen by the maintainer |
