# 09 · Share Files (`.cerebra`)

There's no sync and no accounts. To share, you **export a file** and send it any way you like (WhatsApp,
email, Drive, USB). The other person opens it in Cerebra and gets the same notes, files and connections.

## 1. Export

From a collection's menu, or a multi-selection in the sidebar: **Share as file…**

Options:
- Include original files (PDFs, slides): on by default; shows the size.
- Include AI connections and concept notes: on by default (only *kept* ones, or also *suggested*).
- Password: optional (doc 08 §6).

Result: `Biology.cerebra`.

## 2. Format (version 1)

A zip archive (deflate). Encrypted files are the same zip wrapped in age passphrase encryption; the first bytes
tell them apart (`PK` vs `age-encryption.org/v1`).

```
Biology.cerebra
├── manifest.json
├── notes/              ← the Markdown files, paths relative to the collection
│   ├── Cell Structure.md
│   └── unit3.md
├── files/              ← originals (Files/…)
│   └── unit3.pdf
└── ai-layer.json       ← connections + concepts whose notes are all in this export
```

```json
{
  "format": "cerebra",
  "format_version": 1,
  "app_version": "0.1.0",
  "title": "Biology",
  "description": "Semester 3 notes",
  "created_at": "2026-11-26T12:00:00Z",
  "counts": { "notes": 42, "files": 7, "connections": 120, "concepts": 9 },
  "files": [ { "path": "notes/unit3.md", "sha256": "…", "size": 1234 } ]
}
```

No keys, no index, no settings, no usage data, no absolute paths, no names of AI sources (connection `made_by`
keeps only the provider family, like `gemini`, not key ids).

## 3. Import

Double-click (file association) or **Open share file…** or drag it onto the window.

1. Validate: format, version, checksums, size and path rules (doc 08 §5). Ask for the password when encrypted.
2. Preview: title, counts, list of notes. Choose the target library and collection name (default: title; a
   number is added if the name exists).
3. Copy notes and files; merge the AI layer with ids remapped and paths re-rooted to the new collection.
4. Index. Imported connections keep their status; the agents don't re-run on imported notes unless the user asks.

Opening a newer `format_version` than the app supports shows "Update Cerebra to open this file".

## 4. Why not sync?

Sync needs shared storage, accounts or a server, and every one of those is a setup headache for
non-technical users. A file works everywhere. Sync may come later as an opt-in plugin (doc 11).
