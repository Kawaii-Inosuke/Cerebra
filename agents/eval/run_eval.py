"""Connect the sample library with a real AI source and score the result (docs/06 §8).

    CEREBRA_EVAL_KEY=... uv run --directory agents python eval/run_eval.py \
        --provider groq --model openai/gpt-oss-120b

The library is copied to a temporary folder first, so the fixture is never changed. The agents
program and the `cerebra` CLI (for the MCP tools) are run exactly as the app runs them.
Precision = saved connections that match a labelled pair / all saved connections.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASE_URLS = {
    "groq": "https://api.groq.com/openai/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "deepseek": "https://api.deepseek.com/v1",
    "ollama": "http://localhost:11434",
    "lmstudio": "http://localhost:1234/v1",
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--provider", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--base-url")
    ap.add_argument("--threshold", default="balanced", choices=["strict", "balanced", "generous"])
    ap.add_argument("--library", default=str(ROOT / "fixtures/libraries/biology-small"))
    ap.add_argument("--labels", default=str(ROOT / "agents/eval/biology-small.json"))
    args = ap.parse_args()

    key = os.environ.get("CEREBRA_EVAL_KEY")
    local = args.provider in ("ollama", "lmstudio")
    if not key and not local:
        print("Set CEREBRA_EVAL_KEY to the API key (it is only passed to the agents in memory).")
        return 2

    subprocess.run(["cargo", "build", "-q", "-p", "cerebra-cli"], cwd=ROOT, check=True)
    cli = str(ROOT / "target/debug/cerebra")
    work = Path(tempfile.mkdtemp(prefix="cerebra-eval-"))
    lib = work / "lib"
    shutil.copytree(args.library, lib, ignore=shutil.ignore_patterns(".cerebra"))
    notes = sorted(p.relative_to(lib).as_posix() for p in lib.rglob("*.md"))

    agents = subprocess.Popen(
        ["uv", "run", "--quiet", "--directory", str(ROOT / "agents"), "cerebra-agents"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=open(work / "agents.log", "w"),  # noqa: SIM115
        text=True,
    )
    source = {
        "id": "eval",
        "provider": args.provider,
        "model": args.model,
        "base_url": args.base_url or BASE_URLS.get(args.provider),
        "api_key": key,
        "caps": {},
        "local": local,
        "used_today": {"requests": 0, "tokens": 0},
    }
    calls = 0

    def run_job(i: int, req: dict) -> dict:
        nonlocal calls
        assert agents.stdin and agents.stdout
        agents.stdin.write(json.dumps(req) + "\n")
        agents.stdin.flush()
        for line in agents.stdout:
            msg = json.loads(line)
            if msg.get("method") == "usage":
                calls += msg["params"].get("requests", 0)
            if msg.get("id") == req["id"]:
                return msg.get("result") or {}
        return {"status": "failed", "error": "agents stopped"}

    for i, note in enumerate(notes, 1):
        req = {
            "jsonrpc": "2.0",
            "id": i,
            "method": "run_job",
            "params": {
                "job": {
                    "id": f"eval{i}",
                    "kind": "connect_note",
                    "target": note,
                    "options": {"threshold": args.threshold, "trust": False, "budget": 40},
                },
                "sources": [source],
                "library": str(lib),
                "mcp": {"command": cli, "args": [str(lib), "mcp", "--agent"]},
            },
        }
        res = run_job(i, req)
        for attempt in range(6):  # like the app: a paused job runs again when the source has rested
            if res.get("status") != "paused":
                break
            time.sleep(min(60, 10 * (attempt + 1)))
            req["id"] = 1000 * (attempt + 1) + i
            res = run_job(i, req)
        print(f"[{i}/{len(notes)}] {note}: {res.get('status')} {res.get('saved')} {res.get('error') or ''}")
    agents.terminate()

    layer_file = lib / ".cerebra/ai-layer.json"
    layer = json.loads(layer_file.read_text()) if layer_file.exists() else {}
    title = lambda p: Path(p).stem  # noqa: E731
    saved = {frozenset((title(c["from"]), title(c["to"]))) for c in layer.get("connections", [])}
    good = {frozenset(pair[:2]) for pair in json.loads(Path(args.labels).read_text())["good"]}
    hits = saved & good
    precision = len(hits) / len(saved) if saved else 0.0
    recall = len(hits) / len(good) if good else 0.0
    print(f"\nsaved {len(saved)}, matching labels {len(hits)}, labelled {len(good)}, model calls {calls}")
    print(f"precision {precision:.0%}, recall {recall:.0%}  (target: precision ≥ 80%)")
    for pair in sorted(saved - good, key=sorted):
        print("  not in labels:", " ↔ ".join(sorted(pair)))
    print(f"\nWork folder (delete when done): {work}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
