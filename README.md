# Cerebra

**Turn your notes, PDFs and slides into a connected brain.**

Cerebra is a free, open-source desktop app for students and professionals. Add your material (notes, PDFs,
Word, PowerPoint, even scanned pages), connect an AI you choose (free API keys like Gemini or Groq, or a model
running on your own computer), and Cerebra's agents find the connections that matter between your ideas.
Then ask Claude Desktop or Codex about everything you know, answered from your own material.

- **Everything stays on your computer.** No accounts, no servers, no telemetry.
- **Bring any AI.** Add several API keys; when one hits its limit, the next takes over. Or go fully offline.
- **Works with Obsidian.** A library is a plain folder of Markdown; your vault works as it is.
- **Share a topic as a file.** Export `Biology.cerebra`; a friend opens it and gets the same notes and connections.

> **Status: version 0.1 (first preview).** Everything below works; expect rough edges. See the
> [roadmap](docs/11-ROADMAP.md).

## How it works

1. **Add material.** Create a library (any folder; an Obsidian vault works) and drop in notes, PDFs, Word,
   PowerPoint or photos of pages. Scans are read with on-device OCR.
2. **Add an AI.** Paste one or more API keys (Gemini, Groq, OpenRouter and Mistral have free tiers; OpenAI,
   Anthropic, DeepSeek or any OpenAI-compatible service also work) or use a model on your computer
   (Ollama, LM Studio). Put them in order; when one hits its limit, the next takes over.
3. **Let it connect.** Cerebra's agents (built on [Strands Agents](https://strandsagents.com)) read new
   material, find related passages in your other notes, and keep only connections that are specific,
   useful and backed by exact quotes from both notes. You review them (or let them through).
4. **Ask your AI app.** Click *Connect* for Claude Desktop, Claude Code, Codex or Cursor. Then ask:
   "Using my Cerebra notes, how does osmosis relate to plant transport?"
5. **Share a topic.** *Share as file* makes `Biology.cerebra`; anyone with Cerebra opens it and gets
   the same notes and connections. Optional password.

## Install

Download the installer for your system from the [Releases](../../releases) page, then see
"First launch" below (builds aren't code-signed yet).

## Build from source

You need [Rust](https://rustup.rs) (stable), [Node.js](https://nodejs.org) 20+, and
[uv](https://docs.astral.sh/uv/) for the agents. On Linux also:
`sudo apt install libwebkit2gtk-4.1-dev build-essential libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`.

```bash
git clone https://github.com/Kawaii-Inosuke/Cerebra.git && cd Cerebra
npm install
node scripts/fetch-models.mjs          # ~135 MB of local models (OCR, search by meaning) into ./models
node scripts/build-sidecar.mjs         # the agents program (Python + Strands) as one binary
npm run tauri dev                      # run the app
npm run tauri build                    # make installers in target/release/bundle
```

Try it on the sample library: `fixtures/libraries/biology-small` (20 short biology notes).

The engine also works from the command line (`cargo run -p cerebra-cli -- <library> --help`):
`info`, `search`, `context`, `upload`, `import`, `export`, `import-share`, `mcp`, and `serve`
(a browser preview of the app at http://127.0.0.1:1430 after `npm run build`).

## First launch of a downloaded build

Releases are not signed on macOS (Apple has no free option for open-source projects), and Windows builds are
unsigned until the free open-source certificate is approved ([code signing policy](CODE_SIGNING_POLICY.md)).
Your system will warn you once:

| OS | What you'll see | What to do |
|---|---|---|
| **Windows** | "Windows protected your PC" | Click **More info** → **Run anyway** (only once) |
| **macOS** | "Cerebra can't be opened… Apple could not verify…" | Click **Done**, open **System Settings → Privacy & Security**, find *Cerebra was blocked*, click **Open Anyway** |
| **macOS (terminal)** | Same | `xattr -dr com.apple.quarantine /Applications/Cerebra.app` |
| **Linux** | AppImage won't start | `chmod +x Cerebra_*.AppImage` (or Properties → *Allow executing*) |

Cerebra is free and open source; signing certificates cost money every year. You can check a download against
the SHA-256 sums on the release page, or build it yourself.

## Documentation

Design docs are in [`docs/`](docs/README.md): product, architecture, data model, the Strands agent workflow,
the Claude/Codex connector, security, share files and the roadmap. Decisions made while building are in
[`DECISIONS.md`](DECISIONS.md).

## Privacy

Cerebra collects nothing: no account, no analytics, no server. Your notes and keys stay on your computer,
and text only goes to the AI services you set up yourself. Details: [privacy policy](docs/PRIVACY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Please read the clean-room rule there before working on the link engine.

## License

[MIT](LICENSE). Bundled models and dependencies keep their own licences; see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Cerebra is not affiliated with Obsidian.
