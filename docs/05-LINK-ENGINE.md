# 05 · Link Engine (Obsidian-compatible files, clean-room)

The link engine turns a folder of Markdown into notes, links, backlinks and a graph. It reads the same files
Obsidian does, so a person can keep writing in Obsidian (or any editor) and use Cerebra on top.

## 0. Ground rules (for every contributor)

- **Allowed sources:** Obsidian's public help docs (Internal links, Embed files, Aliases, Tags, Properties,
  Callouts, Comments), the public plugin API type definitions (`obsidian-api` repo), open-source projects
  (Foam, Logseq, `remark-wiki-link`, comrak), and **black-box tests**: make notes in a test vault, use
  Obsidian normally, record what it shows.
- **Not allowed:** unpacking, decompiling or reading Obsidian's shipped app code, or anything derived from it.
  PRs that look derived from it are closed.
- Goal: the same folder gives the same links and backlinks the user sees in Obsidian. Matching Obsidian's
  look or internals is not a goal.

## 1. Pipeline

```
file → SHA-256 ──unchanged?──▶ reuse cached parse
           │ changed
           ▼
       parse()   → NoteMeta { frontmatter, aliases, tags, headings, blocks, links[], embeds[] }
           ▼
       resolve() → each link: target note | unresolved
           ▼
       links table (src, dst|NULL, …)        backlinks = reverse index
           ▼
       graph JSON = note links  ∪  AI layer connections (doc 04 §3), each edge tagged with its origin
```

## 2. Parsing

Frontmatter is split off and parsed as YAML; the body is parsed with a CommonMark + GFM parser; our own passes
handle embeds, subpaths, tags, block ids, callouts and `%% comments %%`. Code blocks, inline code and comments
are masked first, so links inside them are ignored. The same parse feeds the HTML renderer (sanitised), so what
is indexed and what is shown always agree.

| Syntax | Meaning |
|---|---|
| `[[Note]]`, `[[Note\|Shown]]` | Link, with display text |
| `[[Note#Heading]]`, `[[Note#^block]]`, `[[#Heading]]` | Link to heading / block / same-note heading |
| `![[Note]]`, `![[image.png\|300]]` | Embed |
| `[text](Other%20Note.md)` | Markdown link to a local file (URL-decoded) |
| `#tag`, `#nested/tag` | Tag (not in code, URLs or heading markers) |
| `^block-id` at line end | Block id |
| frontmatter `aliases`/`alias`, `tags`/`tag` | Alternative names, tags |
| `%% … %%` | Comment, hidden |
| `> [!type] Title` | Callout |

## 3. Resolution

1. Strip the subpath, trim, URL-decode Markdown links, drop a trailing `.md`.
2. Text with `/` → match the library-relative path case-insensitively; else match by path suffix.
3. Otherwise match by file basename, case-insensitively. Non-Markdown files match by full filename.
4. Ties: same folder as the source → shortest path → alphabetical.
5. Aliases do **not** resolve links (they're for display and search; Cerebra's search does use them).
6. No match → unresolved (shown as a faint dangling node).

## 4. Derived views

| View | Definition |
|---|---|
| Outgoing / backlinks | `links` by `src` / by `dst`, with the line as a snippet |
| AI connections | AI layer connections touching the note, with type, reason, evidence, status |
| Unlinked mentions | FTS hits of a note's title/aliases in notes that don't link to it (also an agent hint) |
| Orphans / dead ends | No links in or out / no links out |
| Graph | Nodes = notes (+ concept notes, optional unresolved, optional tags); edges aggregated per pair with weight |
| Local graph | BFS from a note to depth *d* (default 1) |

### Graph view
Rust sends nodes/edges as JSON; the UI runs d3-force on a canvas, styled per doc 10.
Edge styles: note links = neutral; AI connections = accent colour, dashed while *suggested*, solid when *kept*;
hover shows type + reason. Node size = degree. Colour = collection. Concept notes are drawn as hollow rings.

## 5. Compatibility tests

`fixtures/vaults/compat/` holds small handmade vaults with expected outgoing links, backlinks and unresolved
links recorded by using Obsidian normally. `cargo test` compares engine output with the golden JSON.

| Fixture | Checks |
|---|---|
| F1 basic | `[[Note]]`, display text, case |
| F2 duplicates | Same name in two folders |
| F3 paths | `[[Folder/Note]]`, partial paths, `.md` |
| F4 subpaths | Heading/block links, same-note headings |
| F5 embeds | Note and image embeds, sizes, PDFs |
| F6 code | Links in code are ignored |
| F7 aliases | `[[Alias]]` behaviour |
| F8 markdown links | Relative paths, encoded spaces |
| F9 properties | Links in frontmatter values |
| F10 tags | Inline vs frontmatter, nested, `#` in URLs |
| F11 unicode | Non-Latin names, emoji, spaces |

## 6. Performance

Parse 2,000 notes (≈10 MB) in < 10 s cold and < 200 ms per changed note warm. The parse cache is keyed by hash.
