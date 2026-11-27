"""The sidecar: a JSON-RPC 2.0 server on stdin/stdout (Contract B).

One job runs at a time; `cancel`, `test_source` and `shutdown` are answered while it runs.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
import threading
import time
from collections.abc import Callable
from typing import Any, TextIO

from strands.models import Model

from . import __version__
from .protocol import (
    BUSY,
    INTERNAL_ERROR,
    INVALID_PARAMS,
    METHOD_NOT_FOUND,
    ProtocolError,
    Writer,
    parse_line,
    redact,
    setup_logging,
)
from .rotating import AllSourcesBusy, BudgetExhausted, RotatingModel, SourceSlot, iso, plain_error
from .sources import Source, build_model, list_models, pick_chat_model, wants_lite
from .testing import FakeHook
from .tools import MCPTools, Tools
from .workflow import JobOptions, JobState, run_workflow

log = logging.getLogger("cerebra_agents")

TEST_PROMPT = "Reply with the single word OK."
TEST_TIMEOUT = 45.0

ToolsFactory = Callable[[dict[str, Any] | None], Tools]


def mcp_tools_factory(mcp: dict[str, Any] | None) -> Tools:
    if not isinstance(mcp, dict) or not mcp.get("command"):
        raise ValueError("run_job needs mcp.command")
    args = mcp.get("args") or []
    if not isinstance(args, list):
        raise ValueError("mcp.args must be a list")
    return MCPTools(str(mcp["command"]), [str(a) for a in args])


class Server:
    def __init__(
        self,
        out: Writer,
        *,
        model_factory: Callable[[Source], Model] = build_model,
        tools_factory: ToolsFactory = mcp_tools_factory,
        after_job: Callable[[], None] | None = None,
    ) -> None:
        self.out = out
        self.model_factory = model_factory
        self.tools_factory = tools_factory
        self.after_job = after_job
        self.job_task: asyncio.Task[None] | None = None
        self.job_id: str | None = None
        self.tasks: set[asyncio.Task[Any]] = set()
        self.stopping = asyncio.Event()
        self._saved: dict[str, int] = {"connections": 0, "concepts": 0}

    # -- dispatch -------------------------------------------------------------------------------------

    def handle_line(self, line: str) -> None:
        line = line.strip()
        if not line:
            return
        try:
            msg = parse_line(line)
        except ProtocolError as e:
            self.out.error(None, e.code, str(e))
            return
        id_ = msg.get("id")
        method = msg["method"]
        params = msg["params"]
        if method == "run_job":
            self._start_job(id_, params)
        elif method == "cancel":
            self._cancel(id_, params)
        elif method == "test_source":
            self._spawn(self._test_source(id_, params))
        elif method == "shutdown":
            self._spawn(self._shutdown(id_))
        elif id_ is not None:
            self.out.error(id_, METHOD_NOT_FOUND, f"Unknown method '{method}'")

    def _spawn(self, coro: Any) -> asyncio.Task[Any]:
        task = asyncio.get_running_loop().create_task(coro)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task

    # -- run_job --------------------------------------------------------------------------------------

    def _start_job(self, id_: Any, params: dict[str, Any]) -> None:
        if self.job_task is not None and not self.job_task.done():
            self.out.error(id_, BUSY, f"A job is already running ({self.job_id}).")
            return
        job = params.get("job") or {}
        sources_raw = params.get("sources") or []
        # Register keys with the redactor before anything can log them.
        redact.add(s.get("api_key") for s in sources_raw if isinstance(s, dict))
        if not isinstance(job, dict) or not job.get("id") or not job.get("kind"):
            self.out.error(id_, INVALID_PARAMS, "run_job needs job.id and job.kind")
            return
        self.job_id = str(job["id"])
        self.job_task = self._spawn(self._run_job(id_, job, sources_raw, params.get("mcp")))

    async def _run_job(self, id_: Any, job: dict[str, Any], sources_raw: list[Any], mcp: Any) -> None:
        job_id = str(job["id"])
        try:
            result = await self._execute(job_id, job, sources_raw, mcp)
        except asyncio.CancelledError:
            result = {"status": "cancelled", "saved": self._saved}
        except Exception as e:
            log.exception("job=%s failed", job_id)
            result = {"status": "failed", "saved": self._saved, "error": redact(str(e)) or type(e).__name__}
        finally:
            if self.after_job is not None:
                try:
                    self.after_job()
                except Exception:
                    log.exception("after_job hook failed")
        self.out.result(id_, result)

    async def _execute(self, job_id: str, job: dict[str, Any], sources_raw: list[Any], mcp: Any) -> dict[str, Any]:
        self._saved = {"connections": 0, "concepts": 0}
        sources = []
        for raw in sources_raw:
            try:
                sources.append(Source.from_json(raw))
            except ValueError as e:
                log.warning("skipping a source: %s", e)
        if not sources:
            return {"status": "failed", "saved": self._saved, "error": "No AI source is set up."}

        def on_status(p: dict[str, Any]) -> None:
            self.out.notify("source_status", p)

        def on_usage(p: dict[str, Any]) -> None:
            self.out.notify("usage", p)

        def progress(stage: str, done: int, total: int, message: str) -> None:
            self.out.notify(
                "progress", {"job_id": job_id, "stage": stage, "done": done, "total": total, "message": message}
            )

        options = JobOptions.from_json(job.get("options"), force_lite=wants_lite(sources))
        slots = [SourceSlot(s, self.model_factory(s)) for s in sources]
        model = RotatingModel(slots, on_status, on_usage, budget=options.budget)

        async def replace(source: Source) -> tuple[str, Model] | None:
            available = await asyncio.to_thread(list_models, source)
            new = pick_chat_model([m for m in available if m != source.model])
            if new is None:
                return None
            source.model = new
            return new, self.model_factory(source)

        model.replace_model = replace
        notes = job.get("options", {}).get("notes") if isinstance(job.get("options"), dict) else None
        tools = self.tools_factory(mcp)
        progress("starting", 0, 1, "Starting")
        async with tools:
            state = JobState(job_id=job_id, model=model, tools=tools, options=options, progress=progress)
            try:
                await run_workflow(
                    str(job["kind"]), str(job.get("target") or ""), state, notes if isinstance(notes, list) else None
                )
            finally:
                self._saved = {"connections": state.saved_connections, "concepts": state.saved_concepts}
        result: dict[str, Any] = {"status": "done", "saved": self._saved}
        stop = state.stop
        if isinstance(stop, AllSourcesBusy):
            if stop.next_ready_at is None:
                result.update(status="failed", error=stop.reason)
            else:
                result.update(
                    status="paused",
                    next_ready_at=iso(stop.next_ready_at),
                    error=f"All AI sources are resting, resuming at "
                    f"{time.strftime('%H:%M', time.localtime(stop.next_ready_at))}.",
                )
        elif isinstance(stop, BudgetExhausted):
            result["stopped"] = "budget"
            result["message"] = (
                f"Stopped after {options.budget} model calls (the job budget). Run it again to continue."
            )
        progress("done", 1, 1, "Done")
        return result

    # -- cancel / test_source / shutdown ----------------------------------------------------------------

    def _cancel(self, id_: Any, params: dict[str, Any]) -> None:
        wanted = params.get("job_id")
        running = self.job_task is not None and not self.job_task.done()
        hit = running and (wanted is None or str(wanted) == self.job_id)
        if hit and self.job_task is not None:
            self.job_task.cancel()
        if id_ is not None:
            self.out.result(id_, {"cancelled": bool(hit)})

    async def _test_source(self, id_: Any, params: dict[str, Any]) -> None:
        raw = params.get("source")
        if isinstance(raw, dict):
            redact.add([raw.get("api_key")])
        try:
            source = Source.from_json(raw)  # type: ignore[arg-type]
        except ValueError as e:
            self.out.result(
                id_, {"ok": False, "latency_ms": 0, "model": "", "error": f"The source is not set up: {e}."}
            )
            return
        result = await probe_source(source, self.model_factory)
        self.out.result(id_, result)

    async def _shutdown(self, id_: Any) -> None:
        if self.job_task is not None and not self.job_task.done():
            self.job_task.cancel()
            try:
                await asyncio.wait_for(asyncio.shield(self.job_task), timeout=10)
            except (TimeoutError, asyncio.CancelledError, Exception):
                pass
        if id_ is not None:
            self.out.result(id_, {})
        self.stopping.set()


async def probe_source(source: Source, model_factory: Callable[[Source], Model] = build_model) -> dict[str, Any]:
    """Send one tiny prompt; report latency or a plain-language error."""
    started = time.perf_counter()
    try:
        model = model_factory(source)

        async def once() -> str:
            text = ""
            messages = [{"role": "user", "content": [{"text": TEST_PROMPT}]}]
            async for event in model.stream(messages, None, None):
                delta = event.get("contentBlockDelta", {}).get("delta", {}) if isinstance(event, dict) else {}
                text += delta.get("text", "")
            return text

        await asyncio.wait_for(once(), timeout=TEST_TIMEOUT)
    except asyncio.CancelledError:
        raise
    except TimeoutError:
        return {
            "ok": False,
            "latency_ms": round((time.perf_counter() - started) * 1000),
            "model": source.model,
            "error": f"{source.name} didn't answer within {int(TEST_TIMEOUT)} seconds.",
        }
    except Exception as e:
        log.info("test_source %s failed: %s", source.id, type(e).__name__)
        return {
            "ok": False,
            "latency_ms": round((time.perf_counter() - started) * 1000),
            "model": source.model,
            "error": plain_error(source, e),
        }
    return {"ok": True, "latency_ms": round((time.perf_counter() - started) * 1000), "model": source.model}


def _reader_thread(stream: TextIO, loop: asyncio.AbstractEventLoop, queue: asyncio.Queue[str | None]) -> None:
    try:
        for line in stream:
            loop.call_soon_threadsafe(queue.put_nowait, line)
    except Exception:
        log.exception("stdin reader failed")
    finally:
        loop.call_soon_threadsafe(queue.put_nowait, None)


async def serve(stdin: TextIO, out: Writer, **server_kwargs: Any) -> None:
    server = Server(out, **server_kwargs)
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[str | None] = asyncio.Queue()
    threading.Thread(target=_reader_thread, args=(stdin, loop, queue), daemon=True, name="stdin").start()
    while not server.stopping.is_set():
        get = asyncio.ensure_future(queue.get())
        stop = asyncio.ensure_future(server.stopping.wait())
        done, _ = await asyncio.wait({get, stop}, return_when=asyncio.FIRST_COMPLETED)
        if get not in done:
            get.cancel()
            break
        stop.cancel()
        line = get.result()
        if line is None:  # stdin closed: the app is gone
            if server.job_task is not None and not server.job_task.done():
                server.job_task.cancel()
            break
        try:
            server.handle_line(line)
        except Exception as e:
            log.exception("failed to handle a message")
            out.error(None, INTERNAL_ERROR, f"Internal error: {type(e).__name__}")
    pending = [t for t in server.tasks if not t.done()]
    for t in pending:
        if t is not server.job_task:
            t.cancel()
    if pending:
        await asyncio.wait(pending, timeout=10)


def main() -> None:
    # stdout is the protocol channel: keep the real one for messages and send any stray print to stderr.
    proto_out = sys.stdout
    sys.stdout = sys.stderr
    try:
        proto_out.reconfigure(encoding="utf-8", newline="\n")  # type: ignore[union-attr]
        sys.stdin.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    except (AttributeError, ValueError):
        pass
    setup_logging(level=logging.DEBUG if os.environ.get("CEREBRA_AGENTS_DEBUG") else logging.INFO)
    os.environ.setdefault("OTEL_SDK_DISABLED", "true")
    log.info("cerebra-agents %s ready", __version__)
    kwargs: dict[str, Any] = {}
    hook = FakeHook.from_env()
    if hook is not None:
        if hook.config.get("real_tools"):
            # Integration tests: scripted models, but the real MCP tools of the library.
            log.warning("test hook active: fake models, real tools")
            kwargs = {"model_factory": hook.model_factory}
        else:
            log.warning("test hook active: fake models and fake tools")
            kwargs = {
                "model_factory": hook.model_factory,
                "tools_factory": hook.tools_factory,
                "after_job": hook.after_job,
            }
    try:
        asyncio.run(serve(sys.stdin, Writer(proto_out), **kwargs))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
