# 06 · Agents: the Strands workflow, AI sources and key rotation

The agents are what turn a pile of documents into a connected brain. They run in the background using the
AI sources the user added, and they only save connections that are worth having.

## 1. Where they run

`agents/` is a Python package, `cerebra_agents`, built on **Strands Agents** (`strands-agents` ≥ 1.67, extras
`gemini`, `openai`, `anthropic`, `ollama`, `mistral`). It ships inside the app as one sidecar binary
(PyInstaller, per OS), so users never install Python.

```
cerebra (Rust) ──stdin/stdout JSON-RPC──▶ cerebra-agents
                                            ├─ RotatingModel (all AI sources)
                                            ├─ Strands Graph: reader → scout → linker → judge → writer (→ concept)
                                            └─ MCPClient ──stdio──▶ `cerebra mcp --agent` (tools, doc 07)
```

### Sidecar protocol (JSON-RPC 2.0, one JSON object per line)

| Direction | Method / event | Payload |
|---|---|---|
| app → agents | `run_job` | `{ job: {id, kind, target, options}, sources: [ {id, provider, model, base_url, api_key, caps, local} ], library, settings }` |
| app → agents | `cancel` | `{ job_id }` |
| app → agents | `test_source` | `{ source }` → `{ ok, latency_ms, model, error? }` |
| app → agents | `shutdown` | |
| agents → app | `progress` | `{ job_id, stage, done, total, message }` |
| agents → app | `source_status` | `{ source_id, state: ok/cooling/disabled/capped, until?, reason }` |
| agents → app | `usage` | `{ source_id, requests, input_tokens, output_tokens }` (one per model call) |
| agents → app | result of `run_job` | `{ status: done/failed/cancelled/paused, saved: {connections, concepts}, error?, next_ready_at? }` (paused = all sources resting; the app re-queues the job) |

Keys arrive only inside `run_job` / `test_source`, live in memory, and are never logged (the logger has a
redaction filter for anything that looks like a key).

## 2. AI sources

| Provider | Strands model class | Notes |
|---|---|---|
| Google Gemini | `strands.models.gemini.GeminiModel` | Free tier; default suggestion for students |
| Groq | `strands.models.openai.OpenAIModel`, `base_url=https://api.groq.com/openai/v1` | Free tier, fast |
| OpenRouter | `OpenAIModel`, `base_url=https://openrouter.ai/api/v1` | Many free `:free` models |
| OpenAI | `OpenAIModel` | |
| Anthropic | `strands.models.anthropic.AnthropicModel` | |
| Mistral | `strands.models.mistral.MistralModel` | Free tier |
| DeepSeek, Together, Cerebras, any OpenAI-compatible | `OpenAIModel` + custom `base_url` | "Custom (OpenAI-compatible)" in the UI |
| Ollama (local) | `strands.models.ollama.OllamaModel`, `host=http://localhost:11434` | Fully offline |
| LM Studio / llama.cpp server (local) | `OpenAIModel` with `base_url=http://localhost:1234/v1` (or `strands.models.llamacpp`) | Fully offline |

The add-source screen offers presets (provider + recommended model + where to get a free key) and a
"Detect local models" button that probes Ollama (`/api/tags`) and LM Studio (`/v1/models`).

## 3. The workflow (Strands `GraphBuilder`)

One **connect_note** job runs this graph. LLM nodes are Strands `Agent`s with structured output (Pydantic
models); `scout` and `writer` are plain code nodes (custom `AgentBase` implementations) that call MCP tools, so
they cost no AI tokens.

```
           ┌────────┐  ideas   ┌───────┐ candidates ┌────────┐ proposals ┌───────┐ kept  ┌────────┐
 note ───▶ │ reader │ ───────▶ │ scout │ ─────────▶ │ linker │ ────────▶ │ judge │ ────▶ │ writer │
           └────────┘          └───────┘            └────────┘           └───────┘       └───┬────┘
                                                                                             │ idea seen in ≥ 3 notes
                                                                                             ▼
                                                                                        ┌─────────┐
                                                                                        │ concept │ (conditional edge)
                                                                                        └─────────┘
```

| Node | Kind | Input → output | Tools |
|---|---|---|---|
| **reader** | LLM agent | The note (by section, ≤ 6k tokens per call) → `Ideas`: up to 12 key ideas, each `{name, aliases, kind (definition/process/fact/argument/example/formula), section, quote}` | `read_note` |
| **scout** | code | Each idea → top 6 candidate passages from **other** notes via local hybrid search + unlinked mentions; drops notes already linked to this one for the same idea | `candidates_for` |
| **linker** | LLM agent | One idea + its candidates → `Proposals`: `{to_note, to_anchor, type, reason, quote_from, quote_to}` (zero is fine) | `read_note` (to look closer, max 3 calls) |
| **judge** | LLM agent | Batch of proposals → `Verdicts`: `{proposal_id, score 0–1, keep, why}` using the rubric in §4 | none |
| **writer** | code | Kept proposals → `save_connections` (engine verifies quotes, dedupes, applies limits) | `save_connections` |
| **concept** | LLM agent (conditional) | An idea found in ≥ 3 notes with no concept note yet → `save_concept_note` with a short summary and its notes | `search`, `save_concept_note` |

Other jobs:
- **connect_collection** = a `connect_note` job per note that changed since it was last connected
  (`note_state`), smallest notes first, then one concept pass over the collection.
- **connect_topic** (`"Photosynthesis"`) = reader on the top search passages for the topic → concept node for
  the topic → linker/judge between the concept and each passage's note.

### Prompts
System prompts live in `agents/cerebra_agents/prompts/*.md` (versioned, tested). They tell each agent: use
only the given text; quote exactly; prefer no connection over a weak one; write reasons a student would find
useful ("Unit 3's osmosis section relies on membrane permeability defined here").

### Small and local models
If a source is marked `local` or its model is small (< 14B), the job runs in **lite mode**: linker and judge
merge into one call with a stricter rubric, and the ideas per note drop to 6. Structured output falls back to
JSON mode with one repair retry; a node that still fails is skipped for that idea, not the whole job.

## 4. What counts as "valuable"

The judge scores each proposal on:

| Criterion | Weight | Reject when |
|---|---|---|
| **Grounded:** both quotes support the claim | 0.35 | Either quote doesn't support it |
| **Specific:** names the shared idea and how they relate | 0.25 | "Both are about biology" |
| **Useful:** helps understand, revise, or decide something | 0.25 | Only trivia |
| **New:** not already linked; not the same note or a near-duplicate | 0.15 | Already linked or same source file |

Kept when score ≥ **0.6** (setting: Strict 0.75 / Balanced 0.6 / Generous 0.45). Hard limits: ≤ 8 new
connections per note per job; `related` type needs ≥ 0.75. The engine then **verifies both quotes exist** in
the notes (normalised, fuzzy ≥ 0.9) and drops the connection if not. That is the main guard against invented
links. Connections the user dismissed are never proposed again.

New connections are saved as **suggested**. The user can keep or dismiss them in the Review screen.
Setting "Trust the agents" saves them as kept straight away.

## 5. Key rotation: `RotatingModel`

A custom Strands model provider (`strands.models.Model` subclass) that holds every enabled source in the
user's order and implements `stream`, `structured_output`, `update_config`, `get_config`.

```python
class RotatingModel(Model):
    def __init__(self, slots: list[SourceSlot], on_status, on_usage): ...

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kw):
        for slot in self._ready_slots():                   # user order, skipping cooling / capped / disabled
            try:
                events = [e async for e in slot.model.stream(messages, tool_specs, system_prompt, **kw)]
            except ModelThrottledException as e:            # 429 / quota
                slot.cool_down(retry_after(e)); continue
            except AuthError as e:                          # 401/403, bad key
                slot.disable(str(e)); continue
            except (TimeoutError, ServerError, ConnectionError) as e:
                slot.cool_down(30); continue
            slot.record_usage(events); 
            for e in events: yield e
            return
        raise AllSourcesBusy(next_ready_at=self._next_ready())
```

- **Buffered, not streamed.** Background jobs don't need token streaming, so each call's events are collected
  before being passed on. A source failing half-way can't leave a broken half-answer; the call simply moves to
  the next source.
- **Cool-down:** `Retry-After` when the provider sends it; otherwise 60 s, doubling per repeat up to 15 min;
  reset after a success.
- **Daily caps:** a source at its request or token cap for today is skipped until local midnight.
- **Preference:** always tries sources in the user's order, so the first source is used again as soon as it has
  rested.
- **Context size:** a source whose context window is too small for the request (`ContextWindowOverflowException`)
  is skipped for that call only.
- **All busy:** `AllSourcesBusy` pauses the job; the app shows "All AI sources are resting, resuming at 14:05" and
  resumes automatically.
- **Privacy:** for a collection marked *local only*, the slot list is filtered to local sources (doc 08).

## 6. Cost and limits

- Usage is recorded per source per day (`usage` table) and shown on the AI sources screen.
- Per-job budget: 40 model calls by default; the job stops cleanly when reached and can be continued.
- Auto-connect waits 30 s after a note's last change and skips notes whose text hasn't changed since they were
  last connected.
- A "Connect everything" run on a big library shows an estimate first (notes × ~4 calls) and asks.

## 7. Connections made from Claude Desktop / Codex

The same tools are open to the AI apps (doc 07): `connect` enqueues a job for the app's agents; or the
assistant saves connections itself with `save_connections` (`made_by.kind = assistant`). Both go through the same
quote verification and limits.

## 8. Testing

- Unit tests with a `FakeModel` (scripted responses), including rotation: throttle, auth fail, all busy, caps.
- Workflow tests on `fixtures/libraries/biology-small` with recorded model responses (golden output).
- A manual evaluation set (20 notes, hand-labelled good links) to tune prompts and the threshold; reported as
  precision / recall in `agents/EVAL.md`.
