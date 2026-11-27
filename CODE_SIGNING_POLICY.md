# Code signing policy

Windows releases of Cerebra are signed for free through the SignPath Foundation once the project
is accepted: *Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by
[SignPath Foundation](https://signpath.org).* Until then, and always on macOS (Apple has no free
option), builds are unsigned; see "First launch" in the README.

- **What is signed:** only installers built by this repository's GitHub Actions release workflow
  from a tagged commit. Nothing built on a personal computer is ever signed.
- **Who approves:** releases are tagged and approved by the maintainers listed on the repository
  page. Every signing request is approved by a maintainer.
- **Source and build:** everything in an installer is built from this public repository and its
  locked, open-source dependencies (Cargo.lock, package-lock.json, agents/uv.lock).
- **Privacy:** Cerebra sends nothing anywhere except to the AI services you add yourself, the model
  downloads, and (if left on) the update check. See docs/08-SECURITY-PRIVACY.md.
- **Report a problem:** see SECURITY.md.
