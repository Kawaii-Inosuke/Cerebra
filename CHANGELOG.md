# Changelog

All notable changes are listed here ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format).

## [0.1.2] - 2026-11-28

### Added
- **Update notifications.** A few seconds after start, Cerebra checks for a newer version and offers
  **Update now**, **Later** (asks again tomorrow) or **Next time I open Cerebra**. GitHub installs download,
  install and restart by themselves (signed updates); the Microsoft Store version asks the Store to install
  it; Linux .deb and .rpm installs open the download page. Turn it off, or check by hand, in
  Settings → Help.

## [0.1.1] - 2026-11-28

### Changed
- **Microsoft Store version:** Claude Desktop is set up by hand (Connect your AI → Claude Desktop → Set up →
  Copy setup, then paste it into Claude Desktop's settings). The Store doesn't let apps change other apps'
  settings in AppData, so the package no longer asks for that permission. Claude Code, Codex and Cursor still
  connect in one click, and nothing changes in the GitHub version.

## [0.1.0] - 2026-11-27

### Added
- **Desktop app** (Tauri): create or open a library, Home, Graph, Note (reader + editor with `[[` links),
  collections, command palette (Ctrl+K), uploads with OCR, import of an existing folder of notes, light/dark
  themes, model download on first use, live refresh when files change.
- **AI sources**: any number of API keys (Gemini, Groq, OpenRouter, Mistral, OpenAI, Anthropic, DeepSeek, any
  OpenAI-compatible URL) and local models (Ollama, LM Studio); keys in the OS keychain; daily caps; usage.
- **Agents** (Python, Strands Agents) as a bundled sidecar: reader → scout → linker → judge → writer (+ concept
  notes), key rotation on rate limits and quota, lite mode for small/local models, per-job budget.
- **AI layer**: typed connections with reasons and quotes verified against both notes; suggested / kept /
  dismissed; concept notes; review screen; local-only collections.
- **Job queue** with auto-connect of changed notes.
- **Connector** (MCP over stdio) for Claude Desktop, Claude Code, Codex and Cursor, with one-click setup.
  Asked to connect notes, these apps read them and save the connections themselves (no Cerebra AI key
  needed); they can also queue Cerebra's own agents.
- **Share files** (`.cerebra`): export a collection with its files and connections, optional password;
  safe import.
- **Graph** with readable AI connections: violet arrows point the way the relationship goes and are labelled
  with it (explains, builds on, contrasts with…). Click one for the reason, the quotes from both notes, and
  Keep / Reject. Calm, damped motion.
- **About Cerebra** window: version, what the app does, check for updates, report a problem (with details
  filled in, never keys or notes), the licence and third-party notices.
- **Guided tour** on first open, skippable at every step, restartable from Settings → Help.
- Engine (`cerebra-core`) and `cerebra` CLI; CI and release workflows; `scripts/bump-version.mjs` keeps the
  version the same everywhere.
