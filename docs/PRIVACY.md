# Cerebra privacy policy

*Last updated: 28 November 2026. Applies to Cerebra 0.1.0 and later, from GitHub or the Microsoft Store.*

**Short version: Cerebra collects nothing. Your notes, files and keys stay on your computer. The only
things that leave it are the ones you choose to send to an AI service you set up yourself, plus a check
for new versions that sends nothing about you (you can turn it off).**

## What Cerebra does not do

- No account, no sign-up, no sign-in.
- No analytics, tracking, telemetry, advertising or crash reports.
- No Cerebra server: the project runs no service that your data could be sent to or stored on.
- Cerebra does not sell, share or look at your data. It never has access to it.

## What stays on your computer

- **Your library:** your notes, PDFs, slides and other files live in an ordinary folder you choose.
  Cerebra's search index and AI connections are stored next to them, in a `.cerebra` folder inside that
  library.
- **Settings:** theme, text size and recent libraries, in Cerebra's settings folder on your computer.
- **API keys** you add are kept in your operating system's secure keychain (Windows Credential Manager,
  macOS Keychain or the Linux Secret Service). They are only passed, in memory, to Cerebra's own AI helper
  on your computer, and never written to logs.

## What can leave your computer, and only when you set it up

1. **AI services you add.** To find connections between notes, Cerebra sends passages of your notes to the
   AI service you configured (for example Google Gemini, Groq, OpenAI or Anthropic), using your own key.
   That service then handles the text under **its** privacy policy. Collections you mark as *local only*
   are never sent to an online service. If you use a model on your own computer (Ollama, LM Studio),
   nothing leaves your computer.
2. **AI apps you connect.** If you connect Claude Desktop, Claude Code, Codex or Cursor, that app can read
   and search your library, and save connections, while you use it. What it then sends to its own AI
   provider is covered by that app's privacy policy.
3. **One-time model download.** The small models for search by meaning and for reading scans are
   downloaded once from Hugging Face (huggingface.co) when you first ask for them. No personal data is
   sent; Hugging Face sees an ordinary download request.
4. **Update check.** A few seconds after it starts, Cerebra asks whether a newer version exists: the
   version from GitHub downloads checks a small file on GitHub (`latest.json` in the latest release),
   the Microsoft Store version asks the Microsoft Store. Nothing about you, your library or your keys is
   sent; GitHub or Microsoft see an ordinary request. Updates are only installed when you choose
   **Update now**, and GitHub updates are checked against Cerebra's signature first. Turn the check off in
   **Settings → Help → Check for updates automatically**.
5. **Links you click.** "Check for updates", "Report a problem" and similar buttons open a page in your
   web browser (for example on GitHub). Nothing is sent until you choose to submit something there.
   "Copy details for a bug report" only copies the app version, your operating system and the AI status
   to your clipboard, never keys, notes or file names.
6. **Share files.** A `.cerebra` file you export contains the notes and connections you chose. You decide
   who gets it. You can protect it with a password.

## Children

Cerebra collects no personal data from anyone, including children.

## Deleting your data

Delete the library folder to delete your notes and everything Cerebra made from them. Uninstalling
Cerebra removes the app. Remove keys in **AI sources** (or in your system's keychain).

## Changes

Any change to this policy is published in this file, with its history visible in the project's
repository.

## Contact

Questions: open an issue at <https://github.com/Kawaii-Inosuke/Cerebra/issues>.
