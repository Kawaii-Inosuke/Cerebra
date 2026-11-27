# Code signing policy

Windows releases of Cerebra are signed for free through the SignPath Foundation once the project
is accepted: *Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by
[SignPath Foundation](https://signpath.org).* Until then, and always on macOS (Apple has no free
option), builds are unsigned; see "First launch" in the README.

## What is signed

Only installers built by this repository's GitHub Actions release workflow
(`.github/workflows/release.yml`) from a tagged commit. Nothing built on a personal computer is ever
signed. Everything in an installer is built from this public repository and its locked, open-source
dependencies (`Cargo.lock`, `package-lock.json`, `agents/uv.lock`).

## Team roles

- **Committers and reviewers:** [Kawaii-Inosuke](https://github.com/Kawaii-Inosuke). Changes from
  other contributors arrive as pull requests and are reviewed before they are merged.
- **Approvers:** [Kawaii-Inosuke](https://github.com/Kawaii-Inosuke). Every signing request is
  approved by hand.

All team members use multi-factor authentication on GitHub and SignPath.

## Privacy policy

This program will not transfer any information to other networked systems unless specifically
requested by the user or the person installing or operating it. In practice, Cerebra only connects
to the AI services the user adds, downloads its local models once when the user asks, and opens
links in the user's browser. Details: [docs/PRIVACY.md](docs/PRIVACY.md).

## Report a problem

See [SECURITY.md](SECURITY.md).
