# 10 · Screens & Design

## 1. Design direction

Modern, calm, focused, closer to Linear, Arc or Raycast than to a 2000s notes app. Content first, chrome
quiet, one accent colour that means "AI did this".

| Token | Light | Dark |
|---|---|---|
| Background | `#FAFAF9` | `#0E0E11` |
| Surface (cards, panels) | `#FFFFFF` | `#16161A` |
| Border | `#E7E5E4` | `#26262C` |
| Text / muted | `#1C1917` / `#78716C` | `#EDEDEF` / `#8B8B93` |
| **Accent (AI)** | Violet `#7C3AED` | `#A78BFA` |
| Collection colours | 8-colour palette, AA contrast in both themes | |

- Type: **Inter** (UI), **JetBrains Mono** (code), 14 px base, 1.5 line height for reading.
- Radius 10 px (cards), 8 px (inputs); soft shadows only on floating layers (palette, menus).
- Motion: 150–200 ms ease-out; new AI edges fade in along the graph; respects reduced motion.
- Theme: Light / Dark / System (default System).
- Icons: Lucide. Components: Radix primitives + Tailwind; command palette with `cmdk`.

> The exact look (colours, density, graph style) is chosen in Phase 1 from 2–3 clickable mockups.

## 2. Layout

```
┌──────────────┬───────────────────────────────────────────────────────┬──────────────────┐
│ ◉ Cerebra    │  ⌘K  Search or run a command…                 ● Agents│                  │
│              ├───────────────────────────────────────────────────────┤  Right panel     │
│ ⌂ Home       │                                                       │  (contextual)    │
│ ◎ Graph      │                 main view                             │  · Connections   │
│ ✦ Review  3  │     (Home · Graph · Note · Review · Sources …)        │  · Outline       │
│              │                                                       │  · Job progress  │
│ COLLECTIONS  │                                                       │                  │
│ ● Biology 42 │                                                       │                  │
│ ● Physics 18 │                                                       │                  │
│ ● Work    9  │                                                       │                  │
│ + New        │                                                       │                  │
│              │                                                       │                  │
│ ⚙ Settings   │                                                       │                  │
└──────────────┴───────────────────────────────────────────────────────┴──────────────────┘
```

Sidebar collapses to icons; the right panel toggles (Ctrl+\\). The status pill top-right shows agent state:
Idle / Connecting 3 of 12 / Resting until 14:05 / No AI source.

## 3. Screens

### 3.1 First run (skippable)
Version 1 shows the screens below without a step indicator; a guided tutorial comes in version 2 (PRD §7a, TRD R19).
1. **Welcome**: "Turn your notes into a connected brain." *Create a library* / *Open a folder* / *Open a
   .cerebra file*.
2. **Add material**: big drop zone; or *Import an Obsidian vault*.
3. **Add an AI**: provider cards (Gemini free, Groq free, OpenRouter, OpenAI, Anthropic, Ollama local,
   LM Studio local, Custom); paste key → *Test* → ✓. "Add another for when this one runs out" link.
   *Skip for now* is allowed.
4. **Connect Claude / Codex** (optional): buttons from doc 07.

### 3.2 Home
Collections as cards (colour, note count, connections count, last activity). "Recently connected" feed: new AI
connections as compact cards (`unit3 → Cell Structure · explains · "…reason…"`). Quick actions: Upload,
New note, Connect a topic.

### 3.3 Graph
Full canvas, floating controls (bottom-left): collection filter chips, toggle AI connections, link types,
depth, search highlight, settings drawer (forces, labels, sizes). Click node → right panel preview; double-click
→ open note. Hover edge → type + reason. New edges pulse once in accent.

### 3.4 Note
Reader (rendered Markdown, embedded images, source file chip "unit3.pdf ↗"). Toggle *Edit* (CodeMirror 6,
`[[` autocomplete). Right panel tabs: **Connections** (links, backlinks, AI connections grouped by type with
reason and quotes; keep / dismiss), **Outline**, **Local graph**. Top actions: *Connect this note*, *Copy
context*, *Share*.

### 3.5 Review
Inbox of *suggested* AI connections and concepts. Each card: both note titles, type, reason, the two quotes
side by side, confidence, source model. Keys: **K** keep, **D** dismiss, **J/K** move, bulk actions. Filter
by collection or job.

### 3.6 Agents
Queue (running, queued, paused, done, failed) with progress bars and stages
(reading · finding candidates · linking · judging · saving). Buttons: Pause all, Resume, Connect everything
(shows estimate). Activity log (doc 08 §2). Settings: Auto-connect on/off, value threshold (Strict / Balanced /
Generous), Trust the agents, per-job budget.

### 3.7 AI sources
List in priority order (drag to reorder), each row: provider logo, label, model, status dot (ok / resting
0:58 / capped / key problem), today's usage bar vs cap, Test, Edit, Enable toggle. *Add source*.
*Detect local models*. Explanation line: "When one is busy or out of quota, the next one takes over."

### 3.8 Connect your AI
Cards for Claude Desktop, Claude Code, Codex, Cursor: Connected ✓ / Connect / Remove. "Try asking…" examples.
Copy context box.

### 3.9 Share
Export dialog (doc 09) and import preview.

### 3.10 Settings
Library (location, rebuild index, ignored files), Appearance (theme, density, font size), Privacy (local-only
collections, log prompts, update check), Models (download status, re-download), About (version, licence,
third-party notices, GitHub link).

## 4. Command palette (Ctrl+K)

Search notes and passages; commands: Upload, New note, Connect note/collection/topic, Open review, Add AI
source, Toggle theme, Share collection, Open settings. Every command shows its shortcut.

## 5. Empty and error states

Each screen has a friendly empty state with one action. Errors use plain words and a fix, e.g. *"Groq says the
key is wrong. Paste it again or remove this source."* Never stack traces in the UI (available under
*Copy details*).
