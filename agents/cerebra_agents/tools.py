"""The engine's tools as the workflow sees them (Contract C).

`Tools` is the interface; `MCPTools` talks to `cerebra mcp --agent` over stdio through Strands' MCPClient;
`FakeTools` is an in-memory library for tests and the subprocess test hook.
"""

from __future__ import annotations

import abc
import asyncio
import json
import logging
import re
import uuid
from typing import Any

log = logging.getLogger(__name__)


class ToolError(Exception):
    """A tool reported an error (or its result could not be read)."""


class Tools(abc.ABC):
    """The subset of the MCP tools the workflow uses."""

    async def __aenter__(self) -> Tools:
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None

    @abc.abstractmethod
    async def read_note(self, note: str, heading: str | None = None, page: int | None = None) -> str: ...

    @abc.abstractmethod
    async def candidates_for(self, note: str, idea: str, limit: int = 6) -> list[dict[str, Any]]: ...

    @abc.abstractmethod
    async def save_connections(self, request: dict[str, Any]) -> dict[str, Any]: ...

    @abc.abstractmethod
    async def save_concept_note(
        self, title: str, summary: str, collection: str, notes: list[str]
    ) -> dict[str, Any]: ...

    @abc.abstractmethod
    async def search(self, query: str, collection: str | None = None, limit: int = 8) -> list[dict[str, Any]]: ...

    @abc.abstractmethod
    async def overview(self, collection: str) -> dict[str, Any]: ...

    async def read_full_note(self, note: str, max_pages: int = 3) -> str:
        """Read a note across its pages (each ≤ 9k chars), up to `max_pages`."""
        parts: list[str] = []
        page: int | None = None
        for _ in range(max_pages):
            text = await self.read_note(note, page=page)
            nxt = _next_page_hint(text)
            parts.append(_strip_page_hint(text) if nxt else text)
            if nxt is None:
                break
            page = nxt
        return "\n".join(parts)


_NEXT_PAGE_RE = re.compile(r"next_page\D{0,6}(\d+)", re.IGNORECASE)


def _next_page_hint(text: str) -> int | None:
    tail = text[-300:]
    m = _NEXT_PAGE_RE.search(tail)
    return int(m.group(1)) if m else None


def _strip_page_hint(text: str) -> str:
    idx = text.lower().rfind("next_page")
    if idx >= 0 and idx > len(text) - 300:
        line_start = text.rfind("\n", 0, idx)
        return text[: line_start if line_start >= 0 else idx].rstrip()
    return text


def _loads(text: str) -> Any:
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise ToolError(f"tool returned text that is not JSON: {text[:200]}") from e


class MCPTools(Tools):
    """Tools backed by the engine's MCP server, started from `run_job.mcp = {command, args}`."""

    def __init__(self, command: str, args: list[str] | None = None, *, startup_timeout: int = 60) -> None:
        from mcp import StdioServerParameters
        from mcp.client.stdio import stdio_client
        from strands.tools.mcp import MCPClient

        params = StdioServerParameters(command=command, args=list(args or []))
        self._client = MCPClient(lambda: stdio_client(params), startup_timeout=startup_timeout)
        self._started = False

    async def __aenter__(self) -> MCPTools:
        await asyncio.to_thread(self._client.start)
        self._started = True
        return self

    async def __aexit__(self, *exc: object) -> None:
        if self._started:
            self._started = False
            await asyncio.to_thread(self._client.stop, None, None, None)

    async def _call(self, name: str, arguments: dict[str, Any]) -> str:
        args = {k: v for k, v in arguments.items() if v is not None}
        result = await self._client.call_tool_async(f"cerebra-{uuid.uuid4().hex[:12]}", name, args)
        text = "\n".join(c.get("text", "") for c in result.get("content", []) if isinstance(c, dict))
        if result.get("status") == "error" or result.get("isError"):
            raise ToolError(f"{name}: {text[:300]}")
        return text

    async def read_note(self, note: str, heading: str | None = None, page: int | None = None) -> str:
        return await self._call("read_note", {"note": note, "heading": heading, "page": page})

    async def candidates_for(self, note: str, idea: str, limit: int = 6) -> list[dict[str, Any]]:
        return _loads(await self._call("candidates_for", {"note": note, "idea": idea, "limit": limit}))

    async def save_connections(self, request: dict[str, Any]) -> dict[str, Any]:
        return _loads(await self._call("save_connections", request))

    async def save_concept_note(self, title: str, summary: str, collection: str, notes: list[str]) -> dict[str, Any]:
        return _loads(
            await self._call(
                "save_concept_note", {"title": title, "summary": summary, "collection": collection, "notes": notes}
            )
        )

    async def search(self, query: str, collection: str | None = None, limit: int = 8) -> list[dict[str, Any]]:
        return _loads(await self._call("search", {"query": query, "collection": collection, "limit": min(limit, 12)}))

    async def overview(self, collection: str) -> dict[str, Any]:
        return _loads(await self._call("overview", {"collection": collection}))


# --------------------------------------------------------------------------------------------------------
# Fake library for tests
# --------------------------------------------------------------------------------------------------------


def _norm(text: str) -> str:
    text = re.sub(r"[*_`#>\[\]()!|]", "", text.lower())
    return re.sub(r"\s+", " ", text).strip()


class FakeTools(Tools):
    """An in-memory library that behaves like the engine for the tools the workflow uses.

    `save_connections` verifies quotes (substring after normalising), rejects unknown notes and self-links,
    and records every request in `saved_requests`.
    """

    def __init__(self, notes: dict[str, str], candidates: dict[str, list[dict[str, Any]]] | None = None) -> None:
        self.notes = dict(notes)
        self.candidates = candidates or {}
        self.saved_requests: list[dict[str, Any]] = []
        self.saved: list[dict[str, Any]] = []
        self.concepts: list[dict[str, Any]] = []
        self.calls: list[tuple[str, Any]] = []

    async def read_note(self, note: str, heading: str | None = None, page: int | None = None) -> str:
        self.calls.append(("read_note", note))
        if note not in self.notes:
            raise ToolError(f"unknown note {note}")
        return self.notes[note]

    async def candidates_for(self, note: str, idea: str, limit: int = 6) -> list[dict[str, Any]]:
        self.calls.append(("candidates_for", idea))
        if idea in self.candidates:
            return self.candidates[idea][:limit]
        out = []
        for path, text in self.notes.items():
            if path != note and idea.lower() in text.lower():
                out.append(
                    {
                        "note_id": path,
                        "path": path,
                        "title": path.rsplit("/", 1)[-1].removesuffix(".md"),
                        "heading_path": "",
                        "text": text[:1200],
                    }
                )
        return out[:limit]

    async def save_connections(self, request: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(("save_connections", len(request.get("connections", []))))
        self.saved_requests.append(request)
        saved, rejected = [], []
        for i, c in enumerate(request.get("connections", [])):
            src, dst = c.get("from"), c.get("to")
            if src not in self.notes or dst not in self.notes:
                rejected.append({"index": i, "reason": "unknown_note"})
            elif src == dst:
                rejected.append({"index": i, "reason": "same_note"})
            elif _norm(c.get("quote_from", "")) not in _norm(self.notes[src]) or _norm(
                c.get("quote_to", "")
            ) not in _norm(self.notes[dst]):
                rejected.append({"index": i, "reason": "quote_not_found"})
            else:
                cid = f"c_{len(self.saved) + 1}"
                self.saved.append({"id": cid, **c, "status": request.get("status"), "made_by": request.get("made_by")})
                saved.append(cid)
        return {"saved": saved, "rejected": rejected}

    async def save_concept_note(self, title: str, summary: str, collection: str, notes: list[str]) -> dict[str, Any]:
        cid = f"k_{len(self.concepts) + 1}"
        self.concepts.append({"id": cid, "title": title, "summary": summary, "collection": collection, "notes": notes})
        return {"id": cid}

    async def search(self, query: str, collection: str | None = None, limit: int = 8) -> list[dict[str, Any]]:
        q = query.lower()
        hits = [
            {
                "title": p.rsplit("/", 1)[-1].removesuffix(".md"),
                "path": p,
                "heading_path": "",
                "score": 1.0,
                "text": t[:1200],
            }
            for p, t in self.notes.items()
            if q in t.lower() and (collection is None or p.startswith(collection + "/"))
        ]
        return hits[:limit]

    async def overview(self, collection: str) -> dict[str, Any]:
        notes = [
            {"title": p.rsplit("/", 1)[-1].removesuffix(".md"), "path": p, "links": 0}
            for p in self.notes
            if p.startswith(collection + "/")
        ]
        return {
            "collection": collection,
            "notes": notes,
            "concepts": [c["title"] for c in self.concepts if c["collection"] == collection],
        }
