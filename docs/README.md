# Cerebra: Design Docs

**Cerebra** is a free, open-source desktop app that turns your study material or work documents into a
**connected brain**. You add notes, PDFs, slides and scans. An AI you choose (your own API keys or a model running
on your computer) reads them and builds the **connections that matter** between ideas. Then you ask Claude Desktop
or Codex about everything you know, and they answer from your material like a database.

Everything stays on your computer. There are no accounts, no servers, and nothing to host.

> Status (2026-11-27): version 0.1.0 is built; see the [build log](BUILD-LOG.md). Decisions made while
> building are in `../DECISIONS.md`.

| # | Doc | Read it for |
|---|---|---|
| 01 | [PRD](01-PRD.md) | What Cerebra is, who it's for, and what "done" means |
| 02 | [TRD](02-TRD.md) | Technical requirements and the stack |
| 03 | [Architecture](03-ARCHITECTURE.md) | The parts, how data flows, diagrams |
| 04 | [Data Model](04-DATA-MODEL.md) | Library folder, `.cerebra/` folder, SQLite schema, connection records |
| 05 | [Link Engine](05-LINK-ENGINE.md) | `[[links]]`, backlinks and the graph (Obsidian-compatible files) |
| 06 | [Agents](06-AGENTS-STRANDS.md) | The Strands workflow that builds connections, AI sources and key rotation |
| 07 | [Connector](07-CONNECTOR-MCP.md) | Using Cerebra from Claude Desktop and Codex (MCP) |
| 08 | [Security & Privacy](08-SECURITY-PRIVACY.md) | API keys, what leaves the computer, threat model |
| 09 | [Share Files](09-SHARE-FILES.md) | The `.cerebra` file: share a topic, open it in someone else's app |
| 10 | [Screens & Design](10-SCREENS-DESIGN.md) | Every screen, the modern design system |
| 11 | [Roadmap](11-ROADMAP.md) | Phases, tasks, acceptance criteria |
| 12 | [Open Source](12-OPEN-SOURCE.md) | License, repo layout, contributing, releases |
|  | [Build log](BUILD-LOG.md) | How version 0.1.0 was planned, built, tested and reviewed |

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Name | **Cerebra** (share files: `name.cerebra`) | Short and brain-like. No existing notes app found with this name (checked 2026-11-26) |
| License | **MIT** | Simplest for students and companies to use and fork |
| Platform | Desktop: **Tauri 2 + Rust** engine, **React + TypeScript** screens | Small installer, low memory, works offline |
| Agents | **Strands Agents (Python SDK)** in a bundled sidecar program, run as a **Strands Graph** workflow | Python is the reference Strands SDK, with the most providers; the sidecar is bundled, so users don't install Python |
| AI sources | Any number of **API keys** (Gemini, Groq, OpenRouter, OpenAI, Anthropic, Mistral, any OpenAI-compatible URL) and/or a **local model** (Ollama, LM Studio, llama.cpp) | Students use free tiers; professionals may want privacy |
| Key rotation | One **RotatingModel** wraps every source: when one is rate-limited or out of quota, the next takes over | Free tiers run out fast; the work should never stop |
| AI apps | **Claude Desktop and Codex** (plus Claude Code and Cursor) via a local MCP connector. **No web apps** | No servers or relays to run |
| Sharing | **No sync or accounts.** Export a topic as a `.cerebra` file; opening it imports it | Setting up shared storage is too hard for non-technical users |
| Search | Keywords + **search by meaning** (BGE-small) + **re-ranking** (Jina turbo), all local | Gives the agents and AI apps precise context cheaply |
| Uploads | PDF, Word, PowerPoint, text; **OCR** for scans and pictures (PaddleOCR) | Course material is often scanned |
| Files | A library is a plain folder of Markdown; an Obsidian vault works as is | No lock-in; people can keep their editor |
| UI | New modern design: sidebar + command palette (Ctrl+K), graph front and centre, light **and** dark | The look is chosen with mockups in Phase 1 (doc 10) |

## The clean-room rule

The link engine is written only from Obsidian's public documentation and black-box tests of how vault files
behave, never from Obsidian's app code (doc 05). Contributions must follow the same rule. Cerebra is not
affiliated with Obsidian.
