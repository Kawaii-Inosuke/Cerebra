from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from queue import Empty, Queue
from typing import Any

import pytest
from conftest import LIBRARY, NOTE_A, NOTE_B, cand, run_server

from cerebra_agents.main import Server, probe_source
from cerebra_agents.protocol import Writer, redact, setup_logging
from cerebra_agents.sources import Source
from cerebra_agents.testing import FakeModel
from cerebra_agents.tools import FakeTools

AGENTS_DIR = Path(__file__).resolve().parents[1]

IDEA = {
    "name": "selectively permeable membrane",
    "kind": "definition",
    "section": "Membrane",
    "quote": "The cell membrane is selectively permeable",
}
PROPOSAL = {
    "to_note": NOTE_B,
    "type": "explains",
    "reason": "Osmosis depends on the membrane permeability defined in Cell Structure.",
    "quote_from": "The cell membrane is selectively permeable",
    "quote_to": "Osmosis is the movement of water across a semi-permeable membrane",
}
GOOD_SCRIPT = {
    "Ideas": [{"ideas": [IDEA]}],
    "Proposals": [{"proposals": [PROPOSAL]}],
    "Verdicts": [
        {"verdicts": [{"proposal_id": 1, "grounded": 1, "specific": 0.9, "useful": 0.9, "new": 1, "keep": True}]}
    ],
}
CANDIDATES = {IDEA["name"]: [cand(NOTE_B)]}


def source_json(sid: str, key: str | None, provider: str = "groq", **kw: Any) -> dict[str, Any]:
    return {
        "id": sid,
        "provider": provider,
        "model": kw.pop("model", "llama-3.3-70b"),
        "base_url": None,
        "api_key": key,
        "caps": {"requests_per_day": None, "tokens_per_day": None},
        "local": False,
        "used_today": {"requests": 0, "tokens": 0},
        **kw,
    }


def run_job_params(sources: list[dict[str, Any]], **options: Any) -> dict[str, Any]:
    return {
        "job": {
            "id": "j_1",
            "kind": "connect_note",
            "target": NOTE_A,
            "options": {"threshold": "balanced", "lite": False, "trust": False, "budget": 40, **options},
        },
        "sources": sources,
        "library": "/tmp/library",
        "mcp": {"command": "unused", "args": []},
    }


# ---------------------------------------------------------------------------------------------------------
# In-process
# ---------------------------------------------------------------------------------------------------------


async def test_all_sources_busy_pauses_job():
    scripts = {
        "s1": [{"raise": "throttle", "retry_after": 120}],
        "s2": [{"raise": "throttle", "retry_after": 300}],
    }
    params = run_job_params(
        [source_json("s1", "gsk_aaaaaaaaaaaaaaaaaaaa"), source_json("s2", "gsk_bbbbbbbbbbbbbbbbbb")]
    )
    lib = FakeTools(LIBRARY, CANDIDATES)
    before = time.time()
    result, messages = await run_server(params, model_factory=lambda s: FakeModel(scripts[s.id]), tools=lib)
    res = result["result"]
    assert res["status"] == "paused"
    assert res["saved"] == {"connections": 0, "concepts": 0}
    ready = res["next_ready_at"]
    from datetime import datetime

    assert 110 <= datetime.fromisoformat(ready).timestamp() - before <= 130  # the earlier of the two
    assert "resting" in res["error"]
    statuses = [m["params"] for m in messages if m.get("method") == "source_status"]
    assert [(s["source_id"], s["state"]) for s in statuses] == [("s1", "cooling"), ("s2", "cooling")]
    assert lib.saved_requests == []


async def test_failed_when_every_key_is_wrong():
    params = run_job_params([source_json("s1", "gsk_aaaaaaaaaaaaaaaaaaaa")])
    result, _ = await run_server(
        params, model_factory=lambda s: FakeModel([{"raise": "auth"}]), tools=FakeTools(LIBRARY)
    )
    assert result["result"]["status"] == "failed"
    assert "No AI source is working" in result["result"]["error"]


async def test_keys_never_logged():
    key1 = "gsk_LiveKey1234567890abcdefGHIJ"
    key2 = "plain-custom-key-without-shape"  # only caught because it's registered from the job
    log_stream = io.StringIO()
    handler = setup_logging(stream=log_stream, level=logging.DEBUG)
    try:
        scripts = {
            # The provider echoes the key back in its error, as some do.
            "s1": [{"raise": "auth", "message": f"Incorrect API key provided: {key1}"}],
            "s2": [
                {"raise": "server", "message": f"upstream failed for key={key2} Authorization: Bearer {key2}"},
            ],
        }
        params = run_job_params([source_json("s1", key1), source_json("s2", key2, provider="openai_compatible")])
        _result, messages = await run_server(
            params, model_factory=lambda s: FakeModel(scripts[s.id]), tools=FakeTools(LIBRARY)
        )
        logging.getLogger("cerebra_agents.test").info("source dump %s %s", key1, {"api_key": key2})
        try:
            raise RuntimeError(f"boom {key1}")
        except RuntimeError:
            logging.getLogger("cerebra_agents.test").exception("with traceback")
        res = await probe_source(Source.from_json(source_json("s1", key1)), lambda s: FakeModel([{"raise": "auth"}]))
    finally:
        logging.getLogger().removeHandler(handler)

    logs = log_stream.getvalue()
    protocol = json.dumps(messages) + json.dumps(res)
    assert "Groq says the key is wrong" in logs  # the logs did record the failure…
    for key in (key1, key2):
        assert key not in logs  # …without the key
        assert key not in protocol
    assert "[redacted]" in logs
    # Generic shapes are caught even for keys the job never registered.
    redact.clear()
    assert "sk-proj-abcdefghijklmnop1234" not in redact("key sk-proj-abcdefghijklmnop1234 here")
    assert "AIzaSyA1234567890abcdefghijklmnopqrstu" not in redact("AIzaSyA1234567890abcdefghijklmnopqrstu")


async def test_test_source_reports_errors_plainly():
    groq = Source.from_json(source_json("g", "gsk_wrongwrongwrongwrong"))
    cases = {
        "auth": "Groq says the key is wrong",
        "throttle": "Groq says you've hit its rate limit",
        "not_found": "Groq doesn't know the model 'llama-3.3-70b'",
        "server": "Groq didn't answer in time or had a server problem",
    }
    for kind, expected in cases.items():
        res = await probe_source(groq, lambda s, k=kind: FakeModel([{"raise": k}]))
        assert res["ok"] is False and res["error"].startswith(expected), (kind, res)
        assert res["model"] == "llama-3.3-70b" and isinstance(res["latency_ms"], int)

    ok = await probe_source(groq, lambda s: FakeModel(["OK"]))
    assert ok["ok"] is True and "error" not in ok

    # A real Strands provider pointed at a closed local port: plain message, no crash, no network.
    ollama = Source.from_json(
        {
            "id": "x",
            "provider": "ollama",
            "model": "none",
            "base_url": "http://127.0.0.1:9",
            "api_key": None,
            "local": True,
        }
    )
    res = await probe_source(ollama)
    assert res["ok"] is False
    assert res["error"] == "Couldn't reach Ollama at http://127.0.0.1:9. Is it running?"

    lm = Source.from_json(
        {"id": "y", "provider": "lmstudio", "model": "qwen2.5-7b", "base_url": "http://127.0.0.1:9/v1"}
    )
    res = await probe_source(lm)
    assert res["error"].startswith("Couldn't reach LM Studio at http://127.0.0.1:9/v1")


async def test_test_source_is_answered_while_a_job_runs_and_cancel_works():
    buf = io.StringIO()
    lib = FakeTools(LIBRARY, CANDIDATES)

    def factory(s: Source) -> FakeModel:
        return FakeModel(GOOD_SCRIPT, delay=0.3) if s.id == "slow" else FakeModel(["OK"])

    server = Server(Writer(buf), model_factory=factory, tools_factory=lambda _m: lib)
    server.handle_line(
        json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "run_job",
                "params": run_job_params([source_json("slow", "gsk_slowslowslowslow")]),
            }
        )
    )
    await asyncio.sleep(0.05)
    server.handle_line(
        json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "test_source",
                "params": {"source": source_json("fast", "gsk_fastfastfastfast")},
            }
        )
    )
    server.handle_line(
        json.dumps(
            {"jsonrpc": "2.0", "id": 3, "method": "run_job", "params": run_job_params([source_json("slow", "k")])}
        )
    )
    await asyncio.sleep(0.1)
    server.handle_line(json.dumps({"jsonrpc": "2.0", "id": 4, "method": "cancel", "params": {"job_id": "j_1"}}))
    await asyncio.wait_for(server.job_task, timeout=5)
    msgs = [json.loads(line) for line in buf.getvalue().splitlines()]
    ids = [m.get("id") for m in msgs if "id" in m]
    assert ids.index(2) < ids.index(1)  # test_source answered before the job finished
    by_id = {m["id"]: m for m in msgs if "id" in m}
    assert by_id[2]["result"]["ok"] is True
    assert by_id[3]["error"]["code"] == -32000  # one job at a time
    assert by_id[4]["result"] == {"cancelled": True}
    assert by_id[1]["result"]["status"] == "cancelled"


async def test_bad_lines_get_jsonrpc_errors():
    buf = io.StringIO()
    server = Server(Writer(buf))
    server.handle_line("{not json")
    server.handle_line(json.dumps({"jsonrpc": "2.0", "id": 7, "method": "nope"}))
    server.handle_line(json.dumps({"jsonrpc": "2.0", "id": 8, "method": "test_source", "params": {"source": {}}}))
    await asyncio.sleep(0.05)
    msgs = [json.loads(line) for line in buf.getvalue().splitlines()]
    assert msgs[0]["error"]["code"] == -32700 and msgs[0]["id"] is None
    assert msgs[1]["error"]["code"] == -32601
    assert msgs[2]["result"]["ok"] is False and "not set up" in msgs[2]["result"]["error"]


# ---------------------------------------------------------------------------------------------------------
# Subprocess: the real entry point over stdio
# ---------------------------------------------------------------------------------------------------------


class Sidecar:
    def __init__(self, env: dict[str, str]) -> None:
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "cerebra_agents"],
            cwd=AGENTS_DIR,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )
        self.lines: Queue[str] = Queue()
        self.stderr: list[str] = []
        threading.Thread(target=self._pump, args=(self.proc.stdout, self.lines.put), daemon=True).start()
        threading.Thread(target=self._pump, args=(self.proc.stderr, self.stderr.append), daemon=True).start()

    @staticmethod
    def _pump(stream: Any, sink: Any) -> None:
        for line in stream:
            sink(line)

    def send(self, msg: dict[str, Any]) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()

    def read_until(self, id_: int, timeout: float = 60) -> list[dict[str, Any]]:
        out = []
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                line = self.lines.get(timeout=0.5)
            except Empty:
                continue
            msg = json.loads(line)  # every stdout line must be JSON
            out.append(msg)
            if msg.get("id") == id_:
                return out
        raise AssertionError(f"no response {id_}; stderr:\n{''.join(self.stderr)}")

    def close(self) -> int:
        self.send({"jsonrpc": "2.0", "id": 99, "method": "shutdown"})
        self.read_until(99)
        return self.proc.wait(timeout=20)


@pytest.fixture
def sidecar_env(tmp_path: Path) -> tuple[dict[str, str], Path]:
    dump = tmp_path / "saved.json"
    config = {"model": GOOD_SCRIPT, "notes": LIBRARY, "candidates": CANDIDATES, "dump": str(dump)}
    cfg = tmp_path / "fake.json"
    cfg.write_text(json.dumps(config), encoding="utf-8")
    env = {k: v for k, v in os.environ.items() if not k.startswith("CEREBRA_")}
    env["CEREBRA_AGENTS_FAKE"] = str(cfg)
    env["PYTHONPATH"] = str(AGENTS_DIR)
    return env, dump


def test_protocol_run_job_end_to_end(sidecar_env):
    env, dump = sidecar_env
    key = "gsk_EndToEndKey0987654321zyx"
    car = Sidecar(env)
    try:
        car.send(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "run_job",
                "params": run_job_params([source_json("s_1", key)], trust=True),
            }
        )
        msgs = car.read_until(1)
        assert car.close() == 0
    finally:
        if car.proc.poll() is None:
            car.proc.kill()

    result = msgs[-1]
    assert result == {
        "jsonrpc": "2.0",
        "id": 1,
        "result": {"status": "done", "saved": {"connections": 1, "concepts": 0}},
    }
    notes = [m for m in msgs if "method" in m]
    assert all("id" not in m for m in notes)
    progress = [m["params"] for m in notes if m["method"] == "progress"]
    assert progress and all(set(p) == {"job_id", "stage", "done", "total", "message"} for p in progress)
    assert {p["stage"] for p in progress} >= {"reading", "finding", "linking", "judging", "saving"}
    usage = [m["params"] for m in notes if m["method"] == "usage"]
    assert len(usage) == 3
    assert all(set(u) == {"source_id", "requests", "input_tokens", "output_tokens"} for u in usage)
    assert all(u["source_id"] == "s_1" and u["requests"] == 1 for u in usage)

    [request] = json.loads(dump.read_text())
    assert request["status"] == "kept"
    assert request["made_by"] == {"kind": "agent", "source": "groq:llama-3.3-70b", "job": "j_1"}
    assert request["connections"][0]["to"] == NOTE_B
    assert key not in "".join(car.stderr)
