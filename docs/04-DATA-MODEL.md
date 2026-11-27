# 04 · Data Model

## 1. A library on disk

```
My Library/                     ← any folder; an Obsidian vault works as is
├── Biology/                    ← a collection (top-level folder)
│   ├── Cell Structure.md
│   ├── unit3.md                ← note made from an upload (frontmatter: source)
│   └── Files/unit3.pdf         ← the original
├── Work - Project X/
├── Quick note.md               ← root notes = "Inbox" collection
├── .obsidian/                  ← ignored if present
└── .cerebra/                   ← Cerebra's own data (safe to delete; rebuilt except the AI layer and settings)
    ├── library.json            ← id, created, version, settings for this library
    ├── ai-layer.json           ← AI connections + concept notes (the only thing that is not rebuildable)
    ├── index.db                ← SQLite: notes, links, chunks, full-text search (rebuildable)
    ├── state.db                ← SQLite: job queue, note state, usage (kept)
    └── backups/ai-layer-*.json ← rolling 10 backups
```

Ignored: dot-folders, `node_modules`, files > 50 MB (warned), and anything in `.cerebraignore` (gitignore syntax).

## 2. Notes

Plain Markdown. Frontmatter Cerebra understands (all optional):

```yaml
title: Cell Structure        # else the file name
aliases: [cell parts]
tags: [unit2, exam]
source: Files/unit3.pdf      # set on uploads
cerebra: { auto_connect: false }   # opt a note out of the agents
```

Note id = library-relative path (stable across restarts; renames are tracked by content hash so AI
connections follow the file).

## 3. The AI layer (`ai-layer.json`)

Kept apart from your notes. Nothing here edits your files.

```json
{
  "version": 1,
  "connections": [{
    "id": "c_01J…",                       // ULID
    "from": "Biology/unit3.md",
    "to": "Biology/Cell Structure.md",
    "from_anchor": "#Osmosis",             // optional heading/block
    "to_anchor": "#Membrane",
    "type": "explains",                    // see §4
    "reason": "Unit 3's osmosis section relies on the membrane permeability defined in Cell Structure.",
    "evidence": [
      { "note": "Biology/unit3.md", "quote": "water moves across a semi-permeable membrane…" },
      { "note": "Biology/Cell Structure.md", "quote": "the membrane is selectively permeable…" }
    ],
    "confidence": 0.82,                    // Judge's value score 0–1
    "status": "suggested",                 // suggested | kept | dismissed
    "made_by": { "kind": "agent", "source": "groq:llama-3.3-70b", "job": "j_01J…" },
    "created_at": "2026-11-26T12:00:00Z"
  }],
  "concepts": [{
    "id": "k_01J…",
    "title": "Osmosis",
    "summary": "Movement of water across a selectively permeable membrane…",
    "collection": "Biology",
    "notes": ["Biology/unit3.md", "Biology/Cell Structure.md", "Biology/Plants.md"],
    "made_by": { "kind": "agent", "source": "gemini:gemini-2.5-flash" },
    "status": "suggested",
    "created_at": "…"
  }]
}
```

- `made_by.kind`: `agent` (Strands workflow), `assistant` (Claude Desktop / Codex via MCP), `user`.
- **Dismissed** connections are kept (status only) so the agents never propose them again.
- **Keep as real note**: the user can turn a concept note into a real `.md` file in the collection (`[[links]]`
  to its notes); it then leaves the AI layer.
- Limits: 50k connections, 5k concepts per library; text fields capped (reason 600 chars, quote 400).

## 4. Connection types

| Type | Meaning | Example |
|---|---|---|
| `explains` | A explains or defines something B uses | Definition → application |
| `builds_on` | A extends / requires B (prerequisite) | Unit 4 builds on Unit 2 |
| `example_of` | A is a case / example of B | Case study → principle |
| `contrasts` | A contrasts or contradicts B | Two theories |
| `same_concept` | Same idea under different names | "Mitochondria" ↔ "powerhouse of the cell" |
| `cause_effect` | A causes / leads to B | |
| `part_of` | A is a component of B | |
| `related` | Genuinely related but none of the above (used sparingly; Judge penalises it) | |

## 5. SQLite (`index.db`)

Rebuildable tables:

```sql
CREATE TABLE notes (id TEXT PRIMARY KEY, collection TEXT, path TEXT UNIQUE, title TEXT,
  body TEXT, summary TEXT, frontmatter_json TEXT, hash TEXT);   -- mtime added with the file watcher (Phase 1)
CREATE TABLE aliases (note_id TEXT, alias TEXT);
CREATE TABLE tags (note_id TEXT, tag TEXT);
CREATE TABLE headings (note_id TEXT, level INT, text TEXT, line INT);
CREATE TABLE blocks (note_id TEXT, block_id TEXT, line INT);
CREATE TABLE links (src TEXT, dst TEXT NULL, target_text TEXT, subpath TEXT, display TEXT,
  is_embed INT, kind TEXT, line INT);
CREATE TABLE chunks (id INTEGER PRIMARY KEY, note_id TEXT, heading_path TEXT, text TEXT, tokens INT, line INT);
CREATE VIRTUAL TABLE chunks_fts USING fts5(text, heading_path, title, chunk_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2');
```

Embeddings (search by meaning) are kept next to the index in `.cerebra/vectors.bin`, keyed by chunk text hash,
so unchanged passages are never embedded twice (rebuildable).

Durable tables, in `.cerebra/state.db` (never rebuilt):

```sql
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, kind TEXT,           -- connect_note | connect_collection | connect_topic
  target TEXT, status TEXT,                  -- queued | running | paused | done | failed | cancelled
  priority INT, created_at TEXT, started_at TEXT, finished_at TEXT,
  attempts INT, progress_json TEXT, error TEXT, origin TEXT   -- auto | user | assistant
);
CREATE TABLE note_state (note_id TEXT PRIMARY KEY, connected_hash TEXT, connected_at TEXT);
CREATE TABLE usage (day TEXT, source_id TEXT, requests INT, input_tokens INT, output_tokens INT,
  PRIMARY KEY (day, source_id));
```

`note_state.connected_hash` stops the agents from re-connecting a note whose text hasn't changed.

## 6. AI sources (app settings, not in the library)

`<app-data>/sources.json` (no secrets):

```json
[{ "id": "s_1", "label": "Gemini (free)", "provider": "gemini", "model": "gemini-2.5-flash",
   "base_url": null, "enabled": true, "order": 0,
   "caps": { "requests_per_day": 250, "tokens_per_day": null },
   "privacy": "any" }]
```

The key lives in the keychain under service `cerebra`, account `source:<id>`. `privacy`: `any` | `local_only`
(collections marked private only go to sources with `local: true`, doc 08).

## 7. Chunking

Same rule as the engine: split at H1–H3; sections over 400 tokens split at paragraphs into ~300-token
chunks; each chunk carries its heading path ("Title › H2 › H3").
