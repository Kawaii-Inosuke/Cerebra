# 11 · Roadmap

Each phase ends with something runnable. Version numbers in brackets.

## Phase 0: Repository and engine (0.0.x) ✓
- Repo with MIT `LICENSE`, `README`, `CONTRIBUTING`, `CODE_OF_CONDUCT`, `SECURITY.md`, `THIRD-PARTY-NOTICES.md`,
  `DECISIONS.md`, CI (fmt, clippy, tests on Linux, macOS, Windows).
- `crates/cerebra-core`: library loading, parse, resolve, graph, render, collections, index and search (keywords,
  meaning, re-ranking), context packs, uploads with text extraction and OCR, Obsidian import; compat fixtures.
  (The AI layer and MCP server are written in Phases 2 and 3; keychain with the desktop shell in Phase 1.)
- `cerebra-cli`: `cerebra <library> info|backlinks|outgoing|graph|search|context|upload|import|…`.
- **Done when:** `cargo test --workspace` passes and the compat fixtures pass.

## Phase 1: Library app with the new UI (0.1.0) ✓ (shipped together as 0.1.0)
- Pick the visual direction from 2–3 mockups (doc 10 §1).
- Tauri shell (graph renderer: d3-force on canvas), sidebar, command palette, Home, Graph, Note (reader + simple editor), Upload, Search, Settings,
  light/dark.
- First-run steps 1–2. Obsidian import.
- **Done when:** a student can create a library, drop 10 PDFs, browse the graph and search, on all three OSes.

## Phase 2: AI sources and agents (0.2.0) ✓ (shipped together as 0.1.0)
- `agents/` package: sidecar protocol, `RotatingModel`, source factory, Strands Graph (reader, scout, linker,
  judge, writer, concept), prompts, lite mode.
- Engine: job queue, `note_state`, usage, sidecar manager, `candidates_for`, quote verification,
  `save_connections`, `save_concept_note`.
- UI: AI sources, Agents, Review, first-run step 3, status pill, AI edges in graph and note panel.
- PyInstaller sidecar build script and CI job.
- `fixtures/libraries/biology-small`: ~20 short notes written for the project (MIT, no copied textbook text),
  with a hand-labelled list of the good connections in `agents/eval/biology-small.json`. The maintainer signs
  off the labels.
- **Done when:** with two free keys, Gemini and Groq (one deliberately exhausted), connecting `biology-small`
  finishes with rotation visible and ≥ 80% of kept connections matching the labelled list. Lite mode with a
  local model (e.g. an 8B model on Ollama) is measured and reported, not gated.

## Phase 3: Connector (0.3.0) ✓ (shipped together as 0.1.0)
- MCP tools and prompts from doc 07; one-click setup for Claude Desktop, Claude Code, Codex, Cursor; Copy
  context.
- **Done when:** in Claude Desktop, "explain osmosis with my notes" cites the right notes, and "add this
  summary and connect it" creates a note that gets connected by the agents.

## Phase 4: Share files (0.4.0) ✓ (shipped together as 0.1.0)
- Export / import `.cerebra`, password option, file association, safety checks.
- **Done when:** a collection round-trips between two machines with identical notes and connections.

## Phase 5: Release (1.0.0)
- GitHub Actions: build installers (Windows .msi/.exe, macOS .dmg, Linux .AppImage/.deb) on a version tag;
  checksums; auto-update feed (Tauri updater, opt-out).
- Docs site (from `docs/`), screenshots, demo video, sample library.
- Windows signing (doc 12 §5): `CODE_SIGNING_POLICY.md`, apply to SignPath Foundation after the first public
  release, add the SignPath step to the release workflow; MSIX package + Microsoft Store listing.
- macOS stays unsigned: "First launch" instructions (doc 12 §5) in README, release notes and the first-run help.
- **Done when:** someone who has never seen Cerebra installs it (following the first-launch steps for the
  unsigned warning) and gets first connections in under 5 minutes.

## Added before the first release: About, tour and versioning ✓ (0.1.0, 2026-11-27)

- **Versioning ✓:** `scripts/bump-version.mjs <x.y.z>` sets the version in every file and starts a CHANGELOG
  section, and `--check` verifies they agree. CI runs the check on every push. The Release workflow fails
  when the tag doesn't match the app version. "How to release" is in CONTRIBUTING; store and signing steps
  are in [RELEASING](RELEASING.md).
- **About Cerebra ✓:** a window opened from the library menu, the command palette and Settings → Help. It
  shows the real version (Tauri in the app, `package.json` in the preview), what Cerebra does in five
  points, links (check for updates, docs, "Report a problem" with details filled in), the MIT licence and
  third-party notices inside the app, and "Copy details for a bug report" (version, system, models and agents status; never keys or
  notes). The SignPath credit line gets added once signing is active.
- **Guided tour ✓ (first version):** offered the first time a library opens, with "Show me around" or "Skip
  for now". It has ten steps over the real screens, with Next / Back / Skip, arrow keys and Escape, and
  restarts from Settings → Help and the palette. Still to do: self-completing steps and the sample library
  (PRD §7a).
- **Graph with typed AI connections ✓:** one graph, not two views. Violet AI arrows have a direction and a
  relationship label (on hover, around the selected note, and everywhere when zoomed in). Clicking one opens
  the reason, quotes and Keep / Reject in the side panel. Code: `ui/src/components/graphEngine.ts`
  (`drawEdgeLabels`), `ui/src/lib/graphAi.ts`, `ui/src/components/ConnectionDetails.tsx`.
- **Wording:** no mention of other note apps anywhere in the app. A test (`ui/src/wording.test.ts`)
  keeps it that way.
- **CI fix:** the Linux desktop and release jobs run on Ubuntu 24.04. The prebuilt ONNX Runtime needs
  glibc 2.38+, so the job failed to link on 22.04.

## Next tasks (0.1.x)
- In-app updates (Tauri updater plugin + free update-signing key).
- The tour's self-completing steps and the sample-library offer.
- First public release, then the SignPath application and the Microsoft Store MSIX ([RELEASING](RELEASING.md) §3).

## Later (ideas, not promises)
- Built-in chat for people without Claude Desktop / Codex (using the same AI sources).
- Flashcards and quizzes from connections (spaced repetition).
- Plugins; opt-in sync plugin (folder sync, git).
- Mobile reader.
