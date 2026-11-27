from __future__ import annotations

import asyncio
import io
import json
from typing import Any

import pytest

from cerebra_agents.main import Server
from cerebra_agents.protocol import Writer, redact
from cerebra_agents.rotating import RotatingModel, SourceSlot
from cerebra_agents.sources import Caps, Source
from cerebra_agents.testing import FakeModel
from cerebra_agents.tools import FakeTools
from cerebra_agents.workflow import JobOptions, JobState

NOTE_A = "Biology/Cell Structure.md"
NOTE_B = "Biology/Osmosis.md"
NOTE_C = "Biology/Plants.md"
NOTE_D = "Biology/Kidneys.md"

LIBRARY = {
    NOTE_A: (
        "# Cell Structure\n\n## Membrane\n"
        "The cell membrane is selectively permeable, letting water through but not most solutes.\n\n"
        "## Mitochondria\nMitochondria release energy from glucose during respiration.\n"
    ),
    NOTE_B: (
        "# Osmosis\n\nOsmosis is the movement of water across a semi-permeable membrane "
        "from a dilute solution to a concentrated one.\n"
    ),
    NOTE_C: (
        "# Plants\n\nRoot hair cells take up water by osmosis because the membrane is selectively permeable.\n"
        "Plants use glucose made in photosynthesis.\n"
    ),
    NOTE_D: "# Kidneys\n\nThe kidney nephron reabsorbs water through a selectively permeable membrane.\n",
}


def cand(path: str) -> dict[str, Any]:
    return {
        "note_id": path,
        "path": path,
        "title": path.rsplit("/", 1)[-1][:-3],
        "heading_path": "",
        "text": LIBRARY[path],
    }


class Clock:
    def __init__(self, t: float = 1_000_000.0) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t

    def advance(self, s: float) -> None:
        self.t += s


def make_source(sid: str, provider: str = "groq", model: str = "llama-3.3-70b", **kw: Any) -> Source:
    return Source(id=sid, provider=provider, model=model, api_key=kw.pop("api_key", f"gsk_{sid}secretkey0000"), **kw)


def make_rotating(
    scripts: list[Any], *, clock: Clock | None = None, budget: int | None = None, caps: list[Caps] | None = None
) -> tuple[RotatingModel, list[FakeModel], list[dict[str, Any]], list[dict[str, Any]]]:
    statuses: list[dict[str, Any]] = []
    usage: list[dict[str, Any]] = []
    fakes = [FakeModel(s) for s in scripts]
    slots = [
        SourceSlot(make_source(f"s{i + 1}", caps=(caps[i] if caps else Caps())), fake) for i, fake in enumerate(fakes)
    ]
    model = RotatingModel(slots, statuses.append, usage.append, budget=budget, clock=clock or Clock())
    return model, fakes, statuses, usage


async def collect(model: Any, text: str = "hello") -> list[Any]:
    return [e async for e in model.stream([{"role": "user", "content": [{"text": text}]}], None, None)]


def job_state(model: RotatingModel, tools: FakeTools, **opts: Any) -> tuple[JobState, list[tuple]]:
    progress: list[tuple] = []
    options = JobOptions(**{"threshold": 0.6, **opts})
    state = JobState(job_id="j_1", model=model, tools=tools, options=options, progress=lambda *a: progress.append(a))
    return state, progress


async def run_server(
    params: dict[str, Any],
    *,
    model_factory: Any,
    tools: FakeTools,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Run one run_job through the in-process Server; returns (result message, all messages)."""
    buf = io.StringIO()
    server = Server(Writer(buf), model_factory=model_factory, tools_factory=lambda _m: tools)
    server.handle_line(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "run_job", "params": params}))
    assert server.job_task is not None
    await asyncio.wait_for(server.job_task, timeout=30)
    messages = [json.loads(line) for line in buf.getvalue().splitlines()]
    result = next(m for m in messages if m.get("id") == 1)
    return result, messages


@pytest.fixture(autouse=True)
def _clear_redactor():
    yield
    redact.clear()
