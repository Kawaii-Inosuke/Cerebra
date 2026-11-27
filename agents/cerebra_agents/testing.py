"""Test doubles that need to live in the package (the subprocess test hook imports them).

`FakeModel` is a scripted Strands `Model`: it emits real Strands stream events, so it exercises the same
Agent / structured-output / rotation code paths as a real provider.

The hook: when the environment variable `CEREBRA_AGENTS_FAKE` points to a JSON file, `main` builds every
model with `FakeModel` and uses `FakeTools` instead of the MCP server. The file holds no secrets:

    {"model": {<tool name>: [responses…]},          # script used for every source …
     "models": {"<source id>": {…}},                   # … unless a source has its own
     "notes": {"path.md": "text"}, "candidates": {"idea": [ {note_id, path, title, heading_path, text} ]},
     "dump": "/path/to/write/saved-requests.json", "delay": seconds_per_model_call,
     "real_tools": true}    # keep the real MCP tools (integration tests against a real library)

A response is an object (the structured output), a string (plain text reply), or
`{"raise": "throttle"|"auth"|"server"|"overflow"|"unreachable", "retry_after": seconds}`.
"""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import AsyncGenerator
from pathlib import Path
from typing import Any

from strands.models import Model
from strands.types.exceptions import ContextWindowOverflowException, ModelThrottledException

from .sources import Source
from .tools import FakeTools

FAKE_ENV = "CEREBRA_AGENTS_FAKE"


class FakeHTTPError(Exception):
    """Looks enough like an SDK HTTP error for the classifier: status_code + response.headers."""

    class _Resp:
        def __init__(self, status: int, headers: dict[str, str]) -> None:
            self.status_code = status
            self.headers = headers

    def __init__(self, status: int, message: str, headers: dict[str, str] | None = None) -> None:
        super().__init__(message)
        self.status_code = status
        self.response = self._Resp(status, {k.lower(): v for k, v in (headers or {}).items()})


def make_error(kind: str, retry_after: float | None = None, message: str | None = None) -> Exception:
    if kind == "throttle":
        headers = {"retry-after": str(retry_after)} if retry_after is not None else {}
        cause = FakeHTTPError(429, message or "Rate limit reached", headers)
        err = ModelThrottledException(message or "Rate limit reached")
        err.__cause__ = cause
        return err
    if kind == "auth":
        return FakeHTTPError(401, message or "Invalid API Key")
    if kind == "server":
        return FakeHTTPError(503, message or "Service Unavailable")
    if kind == "overflow":
        return ContextWindowOverflowException(message or "maximum context length exceeded")
    if kind == "unreachable":
        return ConnectionError(message or "Connection refused")
    if kind == "not_found":
        return FakeHTTPError(404, message or "model not found")
    if kind == "bad_output":
        # What Groq sends when the model's tool call doesn't match the schema.
        return FakeHTTPError(
            400, message or "Tool call validation failed: parameters for tool Ideas did not match schema"
        )
    return RuntimeError(message or kind)


class FakeModel(Model):
    """Scripted model.

    `script` is either a list (responses in call order) or a dict keyed by the structured-output tool name
    (`Ideas`, `Proposals`, `Verdicts`, `ScoredProposals`, `ConceptDraft`, or `*` for anything). When a
    keyed list runs out, the model answers `{}` (an empty, valid result).
    """

    def __init__(
        self, script: list[Any] | dict[str, list[Any]] | None = None, model_id: str = "fake", delay: float = 0.0
    ) -> None:
        self.delay = delay
        if isinstance(script, dict):
            self._keyed: dict[str, list[Any]] | None = {k: list(v) for k, v in script.items()}
            self._seq: list[Any] = []
        else:
            self._keyed = None
            self._seq = list(script or [])
        self._config: dict[str, Any] = {"model_id": model_id}
        self.calls: list[dict[str, Any]] = []

    def update_config(self, **model_config: Any) -> None:
        self._config.update(model_config)

    def get_config(self) -> dict[str, Any]:
        return dict(self._config)

    @staticmethod
    def _target_tool(tool_specs: list[dict[str, Any]] | None, tool_choice: Any) -> str | None:
        if isinstance(tool_choice, dict) and "tool" in tool_choice:
            return tool_choice["tool"]["name"]
        names = [t["name"] for t in tool_specs or []]
        # Structured-output tools are named after the pydantic model (CamelCase); MCP-style tools are snake_case.
        output = [n for n in names if n[:1].isupper()]
        return (output or names or [None])[-1]

    def _next(self, tool: str | None) -> Any:
        if self._keyed is not None:
            for key in (tool, "*"):
                if self._keyed.get(key):
                    return self._keyed[key].pop(0)
            return {}
        if not self._seq:
            return {}
        return self._seq.pop(0)

    async def stream(  # type: ignore[override]
        self, messages: Any, tool_specs: Any = None, system_prompt: str | None = None, **kwargs: Any
    ) -> AsyncGenerator[Any, None]:
        tool = self._target_tool(tool_specs, kwargs.get("tool_choice"))
        last_text = ""
        for m in reversed(messages or []):
            texts = [c.get("text", "") for c in m.get("content", []) if isinstance(c, dict)]
            if any(texts):
                last_text = "\n".join(t for t in texts if t)
                break
        self.calls.append({"tool": tool, "prompt": last_text, "system": system_prompt or ""})
        if self.delay:
            await asyncio.sleep(self.delay)
        item = self._next(tool)
        if isinstance(item, BaseException):
            raise item
        if isinstance(item, dict) and "raise" in item:
            raise make_error(item["raise"], item.get("retry_after"), item.get("message"))
        tokens_in = max(1, len(last_text) // 4)
        yield {"messageStart": {"role": "assistant"}}
        if isinstance(item, dict) and tool is not None:
            yield {"contentBlockStart": {"start": {"toolUse": {"name": tool, "toolUseId": f"t{len(self.calls)}"}}}}
            yield {"contentBlockDelta": {"delta": {"toolUse": {"input": json.dumps(item)}}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
            out = len(json.dumps(item)) // 4
        else:
            text = item if isinstance(item, str) else json.dumps(item)
            yield {"contentBlockDelta": {"delta": {"text": text}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "end_turn"}}
            out = len(text) // 4
        yield {
            "metadata": {
                "usage": {"inputTokens": tokens_in, "outputTokens": out, "totalTokens": tokens_in + out},
                "metrics": {"latencyMs": 1},
            }
        }

    async def structured_output(  # type: ignore[override]
        self, output_model: Any, prompt: Any, system_prompt: str | None = None, **kwargs: Any
    ) -> AsyncGenerator[Any, None]:
        item = self._next(output_model.__name__)
        if isinstance(item, dict) and "raise" in item:
            raise make_error(item["raise"], item.get("retry_after"))
        yield {"output": output_model.model_validate(item)}


class FakeHook:
    """Loaded from the `CEREBRA_AGENTS_FAKE` file; supplies model and tools factories to the server."""

    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config
        self.last_tools: FakeTools | None = None

    @classmethod
    def from_env(cls) -> FakeHook | None:
        path = os.environ.get(FAKE_ENV)
        if not path:
            return None
        return cls(json.loads(Path(path).read_text(encoding="utf-8")))

    def model_factory(self, source: Source) -> Model:
        per_source = self.config.get("models", {})
        script = per_source.get(source.id, self.config.get("model", {}))
        return FakeModel(script, model_id=source.model, delay=float(self.config.get("delay", 0)))

    def tools_factory(self, _mcp: dict[str, Any] | None) -> FakeTools:
        self.last_tools = FakeTools(self.config.get("notes", {}), self.config.get("candidates", {}))
        return self.last_tools

    def after_job(self) -> None:
        dump = self.config.get("dump")
        if dump and self.last_tools is not None:
            Path(dump).write_text(json.dumps(self.last_tools.saved_requests), encoding="utf-8")
