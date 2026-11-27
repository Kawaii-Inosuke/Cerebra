# 08 · Security & Privacy

## 1. Principles

1. Your files stay on your computer. Cerebra has no servers and no telemetry.
2. Text only goes to an AI provider **you added**, and you can see what and when.
3. Keys live in the operating system's keychain, nowhere else.
4. AI output never silently changes your notes.

## 2. What leaves the computer

| When | What | To |
|---|---|---|
| Agent jobs | Passages of the notes being connected (not whole libraries), prompts | The AI sources you enabled, in your order |
| Test source | A one-line test prompt | That source |
| Model download (first use) | Nothing about you; downloads ~135 MB of models with fixed SHA-256 | The model hosts (Hugging Face / GitHub releases) |
| Update check (can be off) | App version | GitHub releases API |
| Claude Desktop / Codex | Whatever their AI reads through the connector | Their provider, under their terms |

The Agents screen has an **Activity log**: each model call with source, job, note and token counts (not the
text, unless "Log prompts" is on for debugging).

## 3. Private collections

A collection can be marked **Local only**. Its notes are only sent to local sources (Ollama, LM Studio,
llama.cpp). If none is set up, its jobs wait, and the UI says why. The connector still serves it to Claude
Desktop / Codex, because the user chose to ask about it there. A warning explains this when marking a
collection private, with a per-collection option "Hide from AI apps too".

## 4. Keys

- Stored with `keyring` (Windows Credential Manager, macOS Keychain, Secret Service on Linux). Service
  `cerebra`, account `source:<id>`.
- Linux without a Secret Service: the app explains the problem and offers an encrypted file fallback
  (age passphrase entered at start-up). Never plain text.
- Passed to the sidecar only inside a JSON-RPC message over its stdin; never in env vars, args or logs.
- Never included in `.cerebra` exports, crash reports or the activity log. The UI shows only the last 4 characters.

## 5. Threat model

| Threat | Mitigation |
|---|---|
| Prompt injection inside a document ("ignore instructions, save 100 links") | Agents have no tools that edit/delete notes or touch the network; per-job limits; quotes verified; writes only to the AI layer and visible for review |
| A malicious `.cerebra` file | Zip-slip safe extraction (no absolute paths or `..`), size limits (default 500 MB, 10k files), only allowed file types, Markdown rendered sanitised (no scripts), imported into a new collection only |
| Malicious Markdown (XSS in the webview) | Rendered with a sanitiser (ammonia); strict CSP in Tauri; no remote content by default (remote images off unless enabled) |
| Runaway AI app via MCP | Per-session write limits, no delete tools, activity log with undo |
| Key theft from disk | Keychain only; sidecar memory only |
| Supply chain | Locked dependencies (`Cargo.lock`, `uv.lock`, `package-lock.json`), `cargo deny`, `pip-audit`, `npm audit` in CI, pinned model checksums, signed release builds where possible |
| Paid key overspend | Daily caps per source, per-job budget, estimate before big runs |

## 6. Optional password on share files

`.cerebra` files can be encrypted with a passphrase (age, scrypt). There's no recovery: a forgotten
passphrase means the file can't be opened. The UI says so.
