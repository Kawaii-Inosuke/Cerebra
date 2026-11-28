# Releasing Cerebra

How to publish a version, and how to get rid of the "Windows protected your PC" warning without paying.
The everyday release steps are in [CONTRIBUTING](../CONTRIBUTING.md#how-to-release); this page covers the
first public release and Windows trust. Background and decisions: [doc 12 §5](12-OPEN-SOURCE.md).

## 1. Before the first public release

- [ ] **Licence.** Nothing to apply for: the MIT licence is the `LICENSE` file in the repository root, and
      GitHub shows "MIT license" on the repository page by itself. Keep the copyright line up to date
      (`Copyright (c) 2026 <your name or "The Cerebra contributors">`).
- [ ] **Repository public** on GitHub (Settings → General → Danger Zone → Change visibility). Free CI minutes
      for macOS and Windows builds, SignPath and the Store listing all need a public repository.
- [ ] **Two-factor authentication** on your GitHub account (SignPath requires it for everyone with write access).
- [ ] **CI green** on `main`.
- [ ] **In-app updates (from 0.1.2).** GitHub installs check `latest.json` in the latest release and install
      signed updates. The private signing key is `~/.tauri/cerebra-updater.key` on the maintainer's computer
      (back it up: without it, existing installs can't be updated) and the repository secret
      `TAURI_SIGNING_PRIVATE_KEY`. The public key is in `src-tauri/tauri.conf.json`. A release without the
      secret fails, because the build signs every update. The Microsoft Store version asks the Store instead.

## 2. Publish a version

```bash
node scripts/bump-version.mjs 0.2.0      # every file, plus a CHANGELOG section
# write the CHANGELOG section
git commit -am "Release 0.2.0"
git tag v0.2.0
git push origin main --tags
```

GitHub Actions → **Release** builds Windows (`.msi`, `.exe`), macOS (`.dmg`) and Linux (`.AppImage`,
`.deb`) into a **draft** release with `SHA256SUMS.txt`. Install from the draft on each system you can, then
press **Publish release**. A tag that doesn't match the app's version fails straight away.

## 3. Windows: getting rid of the warning

SmartScreen warns about any download it doesn't know yet. Two free ways out, and you want both: the Store for
people who install from the Store, and SignPath for people who download from GitHub.

### Route A: Microsoft Store (free, no warning at all)

Store apps are signed by Microsoft, so Store installs never show SmartScreen.

1. Create a **free individual developer account** at
   [storedeveloper.microsoft.com](https://storedeveloper.microsoft.com) with a personal Microsoft account.
   (Company accounts cost a one-time $99; individuals pay nothing since September 2025.)
2. In Partner Center: **Apps and games → New product → MSIX or PWA app**, reserve the name "Cerebra".
   Partner Center then shows your **Package/Identity/Name**, **Publisher** (`CN=…`) and **Publisher
   display name**. The MSIX must use exactly these.
3. Make the MSIX from the release's `.msi`, using the free **MSIX Packaging Tool** from the Microsoft Store
   ("Application package" → "Create package on this computer" → choose the `.msi`). Enter the identity
   values from step 2. Do **not** sign it yourself: choose "Do not sign package"; the Store signs it.
4. Submit: upload the `.msix`, add screenshots, description, privacy policy URL (a page in the repo or
   GitHub Pages is fine), age rating. Certification usually takes a few days.
5. Each release: repeat steps 3–4 with the new version. (This can move into CI later.)

The Store only helps people who install **from the Store**. The `.exe`/`.msi` on GitHub still warn until
Route B is done.

### Route B: SignPath Foundation (free signing for GitHub downloads)

SignPath Foundation gives open-source projects a real code-signing certificate for free. Requirements
([signpath.org/terms](https://signpath.org/terms)):

- an **OSI-approved open-source licence** for everything (MIT qualifies; a custom licence would not)
- a public repository, with builds made only by GitHub Actions from that repository
- MFA on GitHub and SignPath
- at least one earlier public release
- `CODE_SIGNING_POLICY.md` in the repo (already there)
- the line *"Free code signing provided by SignPath.io, certificate by SignPath Foundation"* on the release page
  and in the About window

Steps:

1. Publish at least one unsigned release (section 2).
2. Apply at [signpath.org](https://signpath.org) with the repository link.
3. Once accepted, set up the project in SignPath. Add the repository secret `SIGNPATH_API_TOKEN` and the
   variable `SIGNPATH_ENABLED=true`, then replace the placeholder `signpath` job in
   `.github/workflows/release.yml` with `signpath/github-action-submit-signing-request`.
4. Add the SignPath credit line to the About window (`ui/src/components/About.tsx`, under the Licence box) and the release
   notes, and remove the Windows row from the "First launch" table in the README.

Note: a signed file still needs some downloads before SmartScreen fully trusts it. Warnings fade over the
first weeks rather than disappearing on day one. A signed file starts with a better reputation than an
unsigned one, and that reputation carries over to later versions signed with the same certificate.

### Stopgap while waiting for SignPath (free)

After each release you can submit the `.exe` and `.msi` at the
[Microsoft Security Intelligence portal](https://www.microsoft.com/wdsi/filesubmission) as "software
developer". This clears that exact file only, so it has to be redone for every release.

## 4. macOS and Linux

- **macOS:** no free signing exists (Apple's programme is $99/year). Builds are ad-hoc signed so Apple Silicon
  runs them; users follow the "First launch" steps in the README once.
- **Linux:** no signing needed. Users check downloads against `SHA256SUMS.txt`. The builds need glibc 2.38 or
  newer (Ubuntu 24.04, Fedora 39, Debian 13 and later), because the bundled ONNX Runtime does.
