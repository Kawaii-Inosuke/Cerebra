# 01 · PRD: Cerebra

## 1. The problem

Students collect lecture notes, PDFs, slides and scanned handouts across many subjects. Professionals collect
specs, reports, meeting notes and research. In both cases the material sits in separate files, and the
**links between ideas** (this concept explains that one, this case contradicts that rule, this unit builds on
that one) exist only in the person's head.

AI chat apps can help, but:
- pasting files into a chat is slow, hits limits, and is forgotten next time;
- the AI doesn't know which of your hundreds of files matter for a question;
- good AI costs money, and free tiers run out within minutes of heavy use.

## 2. The product

Cerebra is a desktop app that:
1. **Collects** your material into a library (a plain folder): notes, PDFs, Word, PowerPoint, images (OCR).
2. **Connects** it: once you add an AI source (API keys or a local model), a **Strands agent workflow** reads
   new material and saves the **valuable connections** between notes, each with a reason and the evidence.
3. **Shows** it: a live graph, search, and a reader where every note lists what it connects to and why.
4. **Serves** it: Claude Desktop and Codex connect to Cerebra and use it like a database: search, read,
   follow connections, add notes, and ask Cerebra to connect a new document or topic.
5. **Shares** it: export a topic as a `.cerebra` file; anyone with Cerebra opens it and gets the same notes
   and connections.

It keeps working as material grows: every new upload, edit or topic is queued and connected automatically.

## 3. Who it's for

| Persona | Material | What they want |
|---|---|---|
| **Student** (main) | Units, lecture notes, past papers, slides, scans | "Explain Unit 3 using what's in my notes", revision maps, how topics across units relate. Free API keys only |
| **Professional** | Specs, research, reports, meeting notes | Ask across all documents, find related decisions, a private knowledge base; may require a local model |
| **Contributor** | The code | Clear docs, easy dev setup, clean modules |

Non-technical users must be able to install it, add a key, and get connections **without a terminal**.

## 4. Goals

1. Install to first connections in **under 5 minutes** with one free API key (Gemini or Groq).
2. Agents **never stop because one key hit its limit** when another source is available.
3. Connections are **valuable, not noisy**: every saved one has a type, a reason and evidence; trivial ones
   (same heading words, already linked) are rejected.
4. Claude Desktop / Codex can answer questions from the library in **few tokens** (precise passages, not files).
5. Works **fully offline** with a local model.
6. Open source, MIT, buildable by anyone from the README.

## 5. Non-goals (v1)

- Sync between devices, accounts, teams, permissions.
- Web AI apps (claude.ai, chatgpt.com) or any hosted relay or server.
- A built-in chat window. Asking questions happens in Claude Desktop / Codex. (May come later; see doc 11.)
- A full Markdown editor that competes with Obsidian. Cerebra has a simple editor; people may keep their own.
- Mobile apps.

## 6. Anti-goals (would be a failure even if it works)

- A graph full of weak AI links that people stop trusting.
- Changing the user's own notes without asking. AI connections live in a separate layer (doc 04).
- Sending material to an AI provider the user didn't choose, or without them knowing what goes out.
- Burning through a paid key silently. Spending is visible and capped (doc 06 §6).
- Needing Python, Node, Docker or a terminal to use the app.

## 7. Features (v1)

| Area | Feature |
|---|---|
| Library | Create or open a folder; **Collections** = top-level folders (a subject, a course, a project); import an Obsidian vault |
| Upload | Drag and drop PDF, .docx, .pptx, .md, .txt, images; text extraction + OCR; a note per file with the original attached |
| Notes | Read rendered Markdown, simple editor, backlinks, outgoing links, "Connected by AI" list with reasons |
| Graph | Live force graph; filter by collection, tag, link type; AI connections in the accent colour with their type |
| Search | Ctrl+K: notes, headings, passages; keyword + meaning, re-ranked |
| AI sources | Add any number of keys and local models; test each; drag to set the order; per-source daily caps |
| Agents | Auto-connect new material; "Connect this note / collection / topic" on demand; queue with progress, pause, resume; review screen (keep / dismiss) |
| Concept notes | When an idea appears across several notes, the agents may create a **concept note** linking them (in the AI layer) |
| Connector | One click to add Cerebra to Claude Desktop, Claude Code, Codex, Cursor; "Copy context" for any other chat |
| Share | Export a collection or a selection as `.cerebra`; open / double-click to import; optional password |
| Settings | Theme (light / dark / system), library location, model downloads, privacy (what may go to which source) |

## 7a. Guided tutorial (first version in 0.1.0)

| Feature | What it is |
|---|---|
| **Guided tutorial** | An optional, skippable walkthrough for first-time users (offered after the first library opens, and any time from Settings → Help → "Show me around"). It points at the real screens one step at a time: add material → see the graph → add an AI → review connections → ask Claude/Codex. It uses the user's own library (or the sample library if they have none yet), never blocks the app, and remembers which steps are done. Version 1 has no step indicator on the first screens; the tutorial replaces that idea. **0.1.0 ships** the offer card, ten steps over the real screens, Next / Back / Skip at every step, and restart from Settings → Help and the command palette. **Not yet:** steps that complete themselves when the user does the action, and the sample-library offer. While a step is shown, the app behind it is dimmed and doesn't take clicks. |

## 8. Success measures

- First-run funnel: install → library → first upload → AI source added → first connection (target: 70% complete).
- Connection quality: share of AI connections kept vs dismissed (target: ≥ 80% kept).
- Rotation: zero failed jobs caused by one source's limit when another source is healthy.
- Connector: answers in Claude Desktop cite Cerebra passages (manual test set in doc 11).

## 9. Open questions

1. Default "value threshold" for connections (doc 06 §4): start at 0.6 and tune with real material.
2. Do we ship a small built-in chat later for people without Claude Desktop / Codex?
3. ~~Code signing~~ **Decided:** Windows signed for free (SignPath Foundation + Microsoft Store MSIX); macOS
   unsigned with first-launch steps in the README (doc 12 §5).
