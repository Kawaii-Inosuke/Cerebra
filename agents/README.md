# cerebra-agents

Cerebra's background agents. A small Python program (the "sidecar") that the desktop app starts and talks
to over stdin/stdout. It connects notes with [Strands Agents](https://strandsagents.com) using the AI
sources the user added, and saves only valuable, quote-checked connections through the engine's MCP tools.

Spec: `docs/06-AGENTS-STRANDS.md`. License: MIT.

```
app ──stdin/stdout JSON-RPC──▶ cerebra-agents
                                 ├─ RotatingModel   (every AI source, in the user's order)
                                 ├─ Strands graph   reader → scout → linker → judge → writer (→ concept)
                                 └─ MCPClient ──stdio──▶ `cerebra mcp --agent --library <path>`
```

## Layout

| File | What it does |
|---|---|
| `cerebra_agents/main.py` | JSON-RPC loop: `run_job`, `cancel`, `test_source`, `shutdown`. One job at a time; `cancel` and `test_source` are answered while a job runs. |
| `cerebra_agents/protocol.py` | Line framing and the redacting logger (key shapes + the exact keys of the current job). |
| `cerebra_agents/sources.py` | Provider table, default base URLs, provider → Strands model, lite-mode detection. |
| `cerebra_agents/rotating.py` | `RotatingModel(Model)`: rotation, cool-downs, caps, budget, plain-language errors. |
| `cerebra_agents/workflow.py` | The Strands `GraphBuilder` graph and the job kinds. |
| `cerebra_agents/schemas.py` | Pydantic outputs (Ideas, Proposals, Verdicts, ScoredProposals, ConceptDraft) and the rubric. |
| `cerebra_agents/tools.py` | `Tools` interface, `MCPTools` (MCP over stdio), `FakeTools` (tests). |
| `cerebra_agents/prompts/*.md` | System prompts (versioned in their first line). |
| `cerebra_agents/testing.py` | `FakeModel` (scripted Strands model) and the subprocess test hook. |

## Run

```bash
cd agents
uv sync
uv run cerebra-agents          # speaks JSON-RPC on stdin/stdout, logs on stderr
```

Try it by hand:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"test_source","params":{"source":{"id":"x","provider":"ollama","model":"llama3.2:3b","base_url":null,"api_key":null,"caps":{},"local":true,"used_today":{}}}}' | uv run cerebra-agents
```

The app (dev) runs `uv run --directory agents cerebra-agents`; release builds bundle the binary below.
Set `CEREBRA_AGENTS_DEBUG=1` for debug logs. Keys only ever arrive inside `run_job` / `test_source`
messages; they are never read from the environment, files or arguments.

## Protocol (Contract B)

Requests: `run_job {job:{id,kind,target,options:{threshold,lite,trust,budget}}, sources:[…], library, mcp:{command,args}}`,
`cancel {job_id}`, `test_source {source}`, `shutdown`.
`run_job` result: `{status: "done"|"failed"|"cancelled"|"paused", saved:{connections,concepts}, error?}` plus
`next_ready_at` (ISO 8601) when paused, and `stopped: "budget"` + `message` when the job budget ran out.
Notifications: `progress {job_id,stage,done,total,message}`, `source_status {source_id,state,until?,reason}`,
`usage {source_id,requests,input_tokens,output_tokens}` (per model call; the app adds them up).

Job kinds: `connect_note` (target = note path), `connect_collection` (target = collection; notes from
`options.notes` if given, else every note from `overview`), `connect_topic` (target = topic text).

## Test

```bash
uv run pytest -q
uv run ruff check . && uv run ruff format --check .
```

No test touches the network. Models are `FakeModel` (a real `strands.models.Model` that replays scripted
answers as Strands stream events); tools are `FakeTools`, or a tiny MCP server (`tests/fake_mcp_server.py`)
for the stdio round trip. The end-to-end test runs `python -m cerebra_agents` as a subprocess with
`CEREBRA_AGENTS_FAKE=<json>` (see `cerebra_agents/testing.py`), which swaps in the fakes.

## Build the binary

From the repository root:

```bash
node scripts/build-sidecar.mjs
```

This runs PyInstaller with `agents/cerebra-agents.spec` (one file) and copies the result to
`src-tauri/binaries/cerebra-agents-<rust host triple>[.exe]`, the name Tauri's `externalBin` expects.
PyInstaller can't cross-compile: build on each OS.

## Add a provider

1. Add its id to `PROVIDERS` and a human name to `DISPLAY_NAMES` in `sources.py` (and a default base URL
   in `DEFAULT_BASE_URLS` if it speaks the OpenAI API).
2. If it is OpenAI-compatible, that's all: `build_model` falls through to `OpenAIModel`. Otherwise add a
   branch in `build_model` that builds the Strands model class (import it inside the branch so unused
   SDKs never load) and add the SDK as a `strands-agents` extra in `pyproject.toml`, then `uv lock`.
3. Check that its errors classify correctly (`rotating.classify`): 429 → throttle, 401/403 → auth, and
   that `plain_error` reads well. Add a case to `tests/test_rotating.py::test_classify_and_retry_after`.
4. Add the provider to the hidden imports in `cerebra-agents.spec` if its SDK is imported lazily.
5. The app side (presets, "get a free key" link) lives in the UI and `src-tauri`.
