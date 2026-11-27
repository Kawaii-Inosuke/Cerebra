# 12 · Open Source

## 1. License

**MIT** for all Cerebra code. Bundled models keep their own licences (PaddleOCR: Apache-2.0, BGE-small:
MIT, Jina reranker turbo: Apache-2.0), listed in `THIRD-PARTY-NOTICES.md` with every Rust, npm and Python
dependency (generated in CI).

## 2. Repository files

| File | Purpose |
|---|---|
| `README.md` | What it is, screenshot, install, quick start, build from source |
| `LICENSE` | MIT |
| `CONTRIBUTING.md` | Dev setup (Rust, Node, `uv`), how to run each part, tests, the clean-room rule, PR checklist |
| `CODE_OF_CONDUCT.md` | Contributor Covenant 2.1 |
| `SECURITY.md` | How to report vulnerabilities privately (GitHub security advisories) |
| `DECISIONS.md` | Decisions made while building, numbered |
| `CHANGELOG.md` | Keep a Changelog format |
| `.github/` | Issue and PR templates, CI and release workflows |

## 3. Self-setup for users

There's nothing to host. A user:
1. Downloads the installer from GitHub Releases.
2. Gets free keys if they want (the app links to each provider's key page) or installs Ollama / LM Studio.
3. Optionally connects Claude Desktop / Codex with one click.

## 4. Building from source

```bash
# prerequisites: Rust (stable), Node 20+, uv; on Linux the WebKitGTK 4.1 dev packages
npm install
uv sync --directory agents
npm run tauri dev        # fetches models, builds the sidecar in dev mode (runs via uv), opens Cerebra
```

The CLI and browser preview work without Tauri: `cargo run -p cerebra-cli -- <library> serve`.

## 5. CI and releases

- CI on every PR (Linux, macOS, Windows): `cargo fmt --check`, `clippy -D warnings`, `cargo test`,
  `ruff`, `pytest`, `eslint`, `vitest`, licence checks.
- Release on tag `v*`: builds the sidecar with PyInstaller per OS, then Tauri bundles; uploads to the
  project's GitHub Releases with SHA-256 sums.
- **Signing (decided 2026-11-26, zero cost):**
  - **Windows: signed for free**, two ways:
    1. **SignPath Foundation** signs the `.exe`/`.msi` on GitHub Releases. Requirements: OSI licence (MIT ✓),
       public repo, builds from GitHub Actions only, MFA on GitHub and SignPath, at least one earlier release,
       no closed-source parts, a `CODE_SIGNING_POLICY.md` in the repo, and the line *"Free code signing provided
       by SignPath.io, certificate by SignPath Foundation"* on the release page and in About. The certificate's
       publisher is SignPath Foundation. Apply after the first (unsigned) public release; then the release
       workflow submits each build to SignPath and attaches the signed files.
    2. **Microsoft Store**: an **MSIX** package submitted with a free individual developer account (Partner
       Center). The Store signs MSIX itself, so Store installs show no warning. Built in CI from the Tauri
       output with the Windows SDK `makeappx`; uploaded manually per release at first.
  - **macOS: not signed** (no free option). Builds get free ad-hoc signing only, which Apple Silicon needs to run
    at all. Users follow the first-launch steps below.
  - Until the SignPath certificate is approved, Windows builds are unsigned too and the README shows the
    Windows step below; remove that row once signed builds ship.

### First launch on an unsigned build (copied into README and every release)

| OS | What you'll see | What to do |
|---|---|---|
| **Windows** | "Windows protected your PC" (SmartScreen) | Click **More info** → **Run anyway**. Only needed once |
| **macOS 15+** | "Cerebra can't be opened… Apple could not verify…" | Click **Done**, open **System Settings → Privacy & Security**, scroll to *Cerebra was blocked*, click **Open Anyway**, confirm with your password |
| **macOS (terminal alternative)** | Same | `xattr -dr com.apple.quarantine /Applications/Cerebra.app` |
| **Linux** | AppImage won't start | `chmod +x Cerebra_*.AppImage` (or right-click → Properties → *Allow executing*). The `.deb` installs normally |

Also explain why: "Cerebra is free and open source. Signing certificates cost money every year, so builds
aren't signed. You can check a download against the SHA-256 sums on the release page, or build it yourself."

- **Auto-update:** the Tauri updater uses its own free update-signing key (not an OS certificate), so in-app
  updates still work and are verified.

## 6. Zero cost (decided 2026-11-26)

The project must cost the maintainer nothing to run, and users nothing to use:

| Need | Free option |
|---|---|
| Code, issues, discussions | GitHub public repo |
| CI and installer builds (incl. macOS) | GitHub Actions (free for public repos) |
| Downloads | GitHub Releases |
| Website / docs | GitHub Pages (no custom domain needed) |
| AI | Users' own free-tier keys or local models; the project runs no AI |
| Models | Downloaded from their public hosts with pinned checksums |
| Update signing | Tauri updater key (self-generated, free) |
| Windows code signing | SignPath Foundation (GitHub downloads) + Microsoft Store MSIX (free individual account; Store signs) |
| macOS signing | None (no free option); users follow the first-launch steps (§5) |

No feature may require a paid service, a server or a domain.

## 7. Governance

Maintainer-led at the start. Good-first-issues labelled. New AI providers are welcome as small PRs (a preset +
a test) as long as they work through Strands.
