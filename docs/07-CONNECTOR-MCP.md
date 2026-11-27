# 07 · Connector: Cerebra in Claude Desktop and Codex

Cerebra includes an **MCP server** (Model Context Protocol, stdio). AI desktop apps start it as
`cerebra mcp`, and then they can search, read and grow the library like a database. No web apps and no
network server are involved: the AI app runs the Cerebra program on the same computer.

## 1. One-click setup

The *Connect your AI* screen has a button per app. Each one backs up the app's config, adds Cerebra, and
tells the user to restart the app.

| App | Config Cerebra edits |
|---|---|
| Claude Desktop | `claude_desktop_config.json` → `mcpServers.cerebra = { command: <Cerebra binary>, args: ["mcp"] }` |
| Claude Code | `claude mcp add --scope user cerebra -- <binary> mcp` (or `~/.claude.json` when the CLI isn't found) |
| Codex (desktop/CLI) | `~/.codex/config.toml` → `[mcp_servers.cerebra] command = …, args = ["mcp"]` |
| Cursor | `~/.cursor/mcp.json` |
| Anything else | A copyable JSON snippet, plus **Copy context** (a ready-made context pack for any chat) |

`cerebra mcp` serves the library last opened in the app (`connector.json` in app data) and follows when the
user switches libraries.

## 2. Tools

| Tool | What it does | Notes |
|---|---|---|
| `list_collections` | Collections with note counts and last update | |
| `overview` | One collection: notes, top concepts, most-connected notes | Small, for orientation |
| `search` | Hybrid search → top passages with note, heading path, score | `query`, `collection?`, `limit≤12` |
| `read_note` | A note's text, or one section of it | `note`, `heading?`; long notes paginate |
| `related` | A note's links, backlinks and AI connections with type + reason | The "database join" |
| `get_context` | Best passages for a question within a token budget | `question`, `budget≤4000` |
| `add_note` | Creates a note in a collection (Markdown) | Marked `created_by: assistant` in frontmatter; enqueues auto-connect |
| `connect` | Enqueues an agent job: note, collection or topic | Returns job id; the app's agents do the work |
| `job_status` | Status of a job | |
| `save_connections` | Saves connections the assistant found itself | Same format and checks as the agents (quotes verified) |
| `save_concept_note` | Saves a concept note in the AI layer | |
| `list_ai_connections` / `remove_ai_connections` | Review what the AI layer holds | Remove = dismiss |

Agent-only (with `--agent`, used by the Strands sidecar): `candidates_for(note, idea, limit)`.

## 3. Prompts (shown as ready-made actions in the AI apps)

| Prompt | What it asks the AI to do |
|---|---|
| `study_guide` (collection) | A revision guide from the collection, citing notes |
| `explain_with_my_notes` (topic) | Explain a topic using only the library, following connections |
| `find_missing_links` (collection) | Read a collection and save connections that are missing |
| `save_session` | Save the connections found during this conversation |
| `quiz_me` (collection) | Questions from the notes, with answers referencing them |

## 4. Rules the server gives the AI (server instructions)

- Answer from Cerebra's passages and cite the note names; say when the library doesn't cover something.
- Use `search` / `get_context` first, `read_note` only for the notes that matter (saves tokens).
- Save a connection only when two passages are genuinely connected, with exact quotes; never to fill space.
- Never edit or delete the user's own notes (the server has no tool for it).

## 5. Limits and safety

- Responses are capped (default 6k tokens), with `next_page` when longer.
- Writes are limited per session (60 connections, 20 notes) to stop runaway loops.
- All writes are visible in the app's activity list and can be undone.
