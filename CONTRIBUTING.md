# Contributing to Cerebra

Thanks for helping! Cerebra is young, so issues, ideas and small PRs are all welcome.

## Set up

- [Rust](https://rustup.rs) stable (1.95+), [Node.js](https://nodejs.org) 20+
- Later phases also need [`uv`](https://docs.astral.sh/uv/) (Python agents) and, on Linux, the WebKitGTK 4.1
  development packages for the desktop app.

```bash
node scripts/fetch-models.mjs     # local models for OCR and search by meaning (into ./models, not committed)
cargo test --workspace            # engine and CLI tests
cargo run -p cerebra-cli -- <library folder> info
```

Tests that need the models skip cleanly when `./models` is missing.

## Layout

| Path | What |
|---|---|
| `crates/cerebra-core` | The engine: library loading, `[[links]]`, graph, index and search, uploads, OCR, import |
| `crates/cerebra-cli` | The `cerebra` command-line tool |
| `fixtures/libraries/compat` | Small libraries that check links behave like Obsidian (see its `RECORDING.md`) |
| `scripts/` | Model download, sidecar build, `bump-version.mjs` |
| `docs/` | Design docs |

## The clean-room rule

The link engine is written only from Obsidian's **public** help pages and plugin API, open-source projects, and
black-box tests (using Obsidian normally and recording what it shows). **Never** unpack, decompile or read
Obsidian's app code, or use anything derived from it. PRs that look derived from it will be closed.

## Pull request checklist

- [ ] `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings` are clean
- [ ] `cargo test --workspace` passes, with a test for the change (write it first and watch it fail)
- [ ] New dependencies have permissive licences (MIT, Apache-2.0, BSD, ISC, Zlib, MPL-2.0 unmodified)
- [ ] User-facing text is plain and friendly; no paid service, server or account is required for any feature
- [ ] Docs updated if behaviour changed; a `DECISIONS.md` entry for any design decision

## How to release

Versions are git tags (`v0.2.0`). The version is written in several files; never edit them by hand.

1. `node scripts/bump-version.mjs 0.2.0`: sets the version in `package.json`, `package-lock.json`,
   `Cargo.toml`, `Cargo.lock`, `src-tauri/tauri.conf.json`, `agents/pyproject.toml`, `agents/uv.lock` and
   `agents/cerebra_agents/__init__.py`, and adds a `## [0.2.0]` section to `CHANGELOG.md`.
2. Fill in that CHANGELOG section.
3. `git commit -am "Release 0.2.0"`, then `git tag v0.2.0` and `git push origin main --tags`.
4. The Release workflow first checks that the tag matches the version inside the app (it fails otherwise),
   then builds the installers for Windows, macOS and Linux into a **draft** GitHub Release with `SHA256SUMS.txt`.
5. Try the installers from the draft, then press **Publish release**.

CI checks that the versions agree on every push (`node scripts/bump-version.mjs --check`). Store and signing
steps: [`docs/RELEASING.md`](docs/RELEASING.md).

By contributing you agree your work is released under the MIT licence.
