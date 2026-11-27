"""The connect workflow as a Strands graph (doc 06 §3).

    reader → scout → linker → judge → writer ─(idea in ≥ 3 notes)→ concept
    reader → scout → linker+judge (lite) → writer ─…→ concept

Every node is a small custom `AgentBase` implementation bound to one `NoteRun`. LLM nodes run a Strands
`Agent` per call with `structured_output_model=…` and `limits=Limits(structured_output_attempts=2, …)`, which
gives one repair retry (and Strands' JSON-text fallback for models without tool calling); an idea whose
answer still fails is skipped. `scout` and `writer` only call engine tools, so they cost no tokens.
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from functools import cache
from importlib import resources
from typing import Any, TypeVar

from pydantic import BaseModel
from strands import Agent, tool
from strands.agent.agent_result import AgentResult
from strands.agent.conversation_manager import NullConversationManager
from strands.multiagent.graph import Graph, GraphBuilder
from strands.telemetry.metrics import EventLoopMetrics
from strands.types.agent import Limits
from strands.types.exceptions import ContextWindowOverflowException, StructuredOutputException

from .rotating import AllSourcesBusy, BudgetExhausted, RotatingModel
from .schemas import (
    QUOTE_MAX,
    REASON_MAX,
    ConceptDraft,
    Idea,
    Ideas,
    Proposal,
    Proposals,
    ScoredProposals,
    Verdicts,
    passes,
    threshold_value,
)
from .tools import ToolError, Tools

log = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)

DEFAULT_BUDGET = 40
MAX_CONNECTIONS_PER_NOTE = 8
MAX_IDEAS = 12
MAX_IDEAS_LITE = 6
CANDIDATES_PER_IDEA = 6
LINKER_READS = 3
JUDGE_BATCH = 8
READER_SECTION_CHARS = 20_000  # ≈ 5-6k tokens
READER_MAX_SECTIONS = 3
PASSAGE_CHARS = 1_500
LITE_STRICTER = 0.1
CONCEPT_MIN_NOTES = 3
MAX_CONCEPTS_PER_NOTE = 1

ProgressFn = Callable[[str, int, int, str], None]


# --------------------------------------------------------------------------------------------------------
# Options and shared state
# --------------------------------------------------------------------------------------------------------


@dataclass
class JobOptions:
    threshold: float = 0.6
    lite: bool = False
    trust: bool = False
    budget: int = DEFAULT_BUDGET

    @classmethod
    def from_json(cls, raw: dict[str, Any] | None, *, force_lite: bool = False) -> JobOptions:
        raw = raw or {}
        try:
            budget = int(raw.get("budget") or DEFAULT_BUDGET)
        except (TypeError, ValueError):
            budget = DEFAULT_BUDGET
        return cls(
            threshold=threshold_value(raw.get("threshold", "balanced")),
            lite=bool(raw.get("lite")) or force_lite,
            trust=bool(raw.get("trust")),
            budget=max(1, budget),
        )


@dataclass
class Candidate:
    path: str
    title: str
    heading_path: str
    text: str


@dataclass
class Found:
    """A proposal that passed the code checks, with its judgement once judged."""

    id: int
    idea: int
    proposal: Proposal
    source: str
    score: float = 0.0
    kept: bool = False
    why: str = ""


@dataclass
class Saved:
    idea: int
    to_note: str
    quote_to: str


@dataclass
class JobState:
    """Shared by every note in one job: model, tools, counters, stop reason."""

    job_id: str
    model: RotatingModel
    tools: Tools
    options: JobOptions
    progress: ProgressFn
    saved_connections: int = 0
    saved_concepts: int = 0
    stop: BaseException | None = None


@dataclass
class NoteRun:
    """State of one connect_note run, read and written by the graph's nodes."""

    job: JobState
    note: str
    note_text: str = ""
    ideas: list[Idea] = field(default_factory=list)
    candidates: dict[int, list[Candidate]] = field(default_factory=dict)
    found: list[Found] = field(default_factory=list)
    saved: list[Saved] = field(default_factory=list)
    concept_candidates: list[int] = field(default_factory=list)

    @property
    def options(self) -> JobOptions:
        return self.job.options

    @property
    def title(self) -> str:
        return self.note.rsplit("/", 1)[-1].removesuffix(".md")

    @property
    def collection(self) -> str:
        return self.note.split("/", 1)[0] if "/" in self.note else "Inbox"

    def stopped(self) -> bool:
        return self.job.stop is not None

    def progress(self, stage: str, done: int, total: int, message: str) -> None:
        self.job.progress(stage, done, total, message)


# --------------------------------------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------------------------------------


@cache
def load_prompt(name: str) -> str:
    text = resources.files("cerebra_agents").joinpath("prompts", f"{name}.md").read_text(encoding="utf-8")
    return re.sub(r"^<!--.*?-->\s*", "", text, flags=re.DOTALL)


_STRIP_RE = re.compile(r"[*_`#>\[\]()!|]")


def normalise(text: str) -> str:
    """The engine's quote normalisation: lowercase, drop Markdown punctuation, collapse whitespace."""
    return re.sub(r"\s+", " ", _STRIP_RE.sub("", text.lower())).strip()


def quote_ok(text: str, quote: str) -> bool:
    """Same rule as the engine: normalised substring, else best token-window overlap ≥ 0.9."""
    q = normalise(quote)
    if len(q) < 8:
        return False
    t = normalise(text)
    if q in t:
        return True
    q_tokens, t_tokens = q.split(), t.split()
    n = len(q_tokens)
    if n == 0 or len(t_tokens) < n:
        return False
    want: dict[str, int] = {}
    for tok in q_tokens:
        want[tok] = want.get(tok, 0) + 1
    best = 0
    for start in range(len(t_tokens) - n + 1):
        have: dict[str, int] = {}
        for tok in t_tokens[start : start + n]:
            have[tok] = have.get(tok, 0) + 1
        overlap = sum(min(c, have.get(tok, 0)) for tok, c in want.items())
        best = max(best, overlap)
        if best == n:
            break
    return best / n >= 0.9


def split_sections(text: str, limit: int = READER_SECTION_CHARS, max_sections: int = READER_MAX_SECTIONS) -> list[str]:
    """Split at headings into pieces of at most `limit` characters."""
    if len(text) <= limit:
        return [text]
    blocks = re.split(r"(?m)^(?=#{1,3} )", text)
    out: list[str] = []
    cur = ""
    for block in blocks:
        while len(block) > limit:
            if cur:
                out.append(cur)
                cur = ""
            out.append(block[:limit])
            block = block[limit:]
        if len(cur) + len(block) > limit and cur:
            out.append(cur)
            cur = ""
        cur += block
    if cur:
        out.append(cur)
    return out[:max_sections]


def _find_stop(e: BaseException) -> BaseException | None:
    seen: set[int] = set()
    cur: BaseException | None = e
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        if isinstance(cur, (AllSourcesBusy, BudgetExhausted)):
            return cur
        original = getattr(cur, "original_exception", None)
        cur = original if isinstance(original, BaseException) else (cur.__cause__ or cur.__context__)
    return None


class StopJob(Exception):
    """Raised inside a node when the job must stop (all sources busy, budget used)."""


async def ask(
    run: NoteRun,
    prompt: str,
    user_text: str,
    output_model: type[T],
    *,
    tools: list[Any] | None = None,
    turns: int = 3,
    **fmt: Any,
) -> tuple[T | None, str]:
    """One structured LLM call. Returns (output or None if it could not be parsed, source label)."""
    if run.stopped():
        raise StopJob()
    system = load_prompt(prompt)
    for key, value in fmt.items():
        system = system.replace("{" + key + "}", str(value))
    agent = Agent(
        model=run.job.model,
        system_prompt=system,
        tools=tools or [],
        callback_handler=None,
        conversation_manager=NullConversationManager(),
    )
    try:
        result = await agent.invoke_async(
            user_text,
            structured_output_model=output_model,
            limits=Limits(structured_output_attempts=2, turns=turns),
        )
    except asyncio.CancelledError:
        raise
    except Exception as e:
        stop = _find_stop(e)
        if stop is not None:
            run.job.stop = stop
            raise StopJob() from stop
        if isinstance(e, (StructuredOutputException, ContextWindowOverflowException)):
            log.info("node=%s | skipped: %s", prompt, type(e).__name__)
            return None, run.job.model.source_label
        log.warning("node=%s | skipped after error: %s", prompt, e)
        return None, run.job.model.source_label
    out = result.structured_output
    if out is not None and not isinstance(out, output_model):
        out = None
    if out is None:
        log.info("node=%s | no valid structured output (stop_reason=%s), skipped", prompt, result.stop_reason)
    return out, run.job.model.source_label


# --------------------------------------------------------------------------------------------------------
# Graph nodes
# --------------------------------------------------------------------------------------------------------


class CodeNode:
    """Minimal `strands.agent.AgentBase` implementation: `invoke_async`, `__call__`, `stream_async`.

    The graph passes the previous nodes' text as `prompt`; these nodes share state through `NoteRun`
    instead, and return a one-line summary as their text.
    """

    name = "node"

    def __init__(self, run: NoteRun) -> None:
        self.run = run

    async def work(self) -> str:
        raise NotImplementedError

    async def invoke_async(self, prompt: Any = None, **kwargs: Any) -> AgentResult:
        if self.run.stopped():
            summary = "skipped: job stopping"
        else:
            try:
                summary = await self.work()
            except StopJob:
                summary = "stopped"
        return AgentResult(
            stop_reason="end_turn",
            message={"role": "assistant", "content": [{"text": summary}]},
            metrics=EventLoopMetrics(),
            state={},
        )

    def __call__(self, prompt: Any = None, **kwargs: Any) -> AgentResult:
        return asyncio.run(self.invoke_async(prompt, **kwargs))

    async def stream_async(self, prompt: Any = None, **kwargs: Any) -> AsyncIterator[Any]:
        yield {"result": await self.invoke_async(prompt, **kwargs)}


class ReaderNode(CodeNode):
    name = "reader"

    async def work(self) -> str:
        run = self.run
        run.progress("reading", 0, 1, f"Reading {run.title}")
        try:
            run.note_text = await run.job.tools.read_full_note(run.note)
        except ToolError as e:
            log.warning("reader | cannot read note: %s", e)
            return "note could not be read"
        if not run.note_text.strip():
            return "empty note"
        max_ideas = MAX_IDEAS_LITE if run.options.lite else MAX_IDEAS
        sections = split_sections(run.note_text)
        seen: set[str] = set()
        for i, section in enumerate(sections):
            run.progress("reading", i, len(sections), f"Reading {run.title}")
            user = f"Note: {run.note}\n\n<note>\n{section}\n</note>"
            out, _ = await ask(run, "reader", user, Ideas, max_ideas=max_ideas)
            for idea in out.ideas if out else []:
                key = idea.name.strip().lower()
                if not key or key in seen or not quote_ok(run.note_text, idea.quote):
                    continue
                seen.add(key)
                run.ideas.append(idea)
            if len(run.ideas) >= max_ideas:
                break
        run.ideas = run.ideas[:max_ideas]
        run.progress("reading", 1, 1, f"Found {len(run.ideas)} ideas in {run.title}")
        return f"{len(run.ideas)} ideas"


class ScoutNode(CodeNode):
    name = "scout"

    async def work(self) -> str:
        run = self.run
        total = len(run.ideas)
        for i, idea in enumerate(run.ideas):
            run.progress("finding", i, total, f"Looking for notes about {idea.name}")
            query = idea.name if not idea.aliases else f"{idea.name} ({', '.join(idea.aliases[:3])})"
            try:
                raw = await run.job.tools.candidates_for(run.note, query, CANDIDATES_PER_IDEA)
            except ToolError as e:
                log.warning("scout | candidates_for failed: %s", e)
                raw = []
            cands: list[Candidate] = []
            seen: set[str] = set()
            for c in raw or []:
                path = str(c.get("path") or c.get("note_id") or "")
                if not path or path == run.note or path in seen:
                    continue
                seen.add(path)
                cands.append(
                    Candidate(
                        path=path,
                        title=str(c.get("title") or path),
                        heading_path=str(c.get("heading_path") or ""),
                        text=str(c.get("text") or ""),
                    )
                )
            if cands:
                run.candidates[i] = cands
        run.progress("finding", total, total, f"Found candidates for {len(run.candidates)} ideas")
        return f"candidates for {len(run.candidates)} ideas"


def _idea_block(run: NoteRun, idea: Idea) -> str:
    aliases = f" (also: {', '.join(idea.aliases)})" if idea.aliases else ""
    section = f"\nSection: {idea.section}" if idea.section else ""
    head = f"This note: {run.note}\nIdea: {idea.name}{aliases} [{idea.kind}]{section}"
    return f'{head}\nQuote from this note: "{idea.quote}"'


def _candidates_block(cands: list[Candidate]) -> str:
    parts = []
    for n, c in enumerate(cands, 1):
        heading = f" › {c.heading_path}" if c.heading_path else ""
        parts.append(
            f"[{n}] path: {c.path}\ntitle: {c.title}{heading}\n<passage>\n{c.text[:PASSAGE_CHARS]}\n</passage>"
        )
    return "\n\n".join(parts)


def _resolve_target(to_note: str, cands: list[Candidate]) -> Candidate | None:
    key = to_note.strip().strip("[]")
    for c in cands:
        if key in (c.path, c.title) or key.lower() in (c.path.lower(), c.title.lower()):
            return c
    m = re.fullmatch(r"\[?(\d+)\]?", key)
    if m and 1 <= int(m.group(1)) <= len(cands):
        return cands[int(m.group(1)) - 1]
    return None


class _LinkingBase(CodeNode):
    """Shared checks for linker output: known target, not self, quotes really in the texts."""

    async def _full_text(self, path: str, cache_: dict[str, str]) -> str:
        if path not in cache_:
            try:
                cache_[path] = await self.run.job.tools.read_note(path)
            except ToolError:
                cache_[path] = ""
        return cache_[path]

    async def accept(
        self, idea_idx: int, proposal: Proposal, cands: list[Candidate], used: set[str], texts: dict[str, str]
    ) -> Proposal | None:
        run = self.run
        target = _resolve_target(proposal.to_note, cands)
        if target is None or target.path == run.note or target.path in used:
            return None
        if not quote_ok(run.note_text, proposal.quote_from):
            return None
        if not quote_ok(target.text, proposal.quote_to) and not quote_ok(
            await self._full_text(target.path, texts), proposal.quote_to
        ):
            return None
        used.add(target.path)
        return proposal.model_copy(update={"to_note": target.path})

    def read_tool(self) -> Any:
        run = self.run
        reads = {"n": 0}

        @tool
        async def read_note(note: str, heading: str | None = None) -> str:
            """Read another note in the library to look closer at a candidate.

            Args:
                note: The note's path, exactly as given in the candidates.
                heading: Optional heading to read only that section.
            """
            if reads["n"] >= LINKER_READS:
                return "Read limit reached (3). Decide with what you have."
            reads["n"] += 1
            try:
                text = await run.job.tools.read_note(note, heading=heading)
            except ToolError as e:
                return f"Could not read that note: {e}"
            return text[:6000]

        return read_note


class LinkerNode(_LinkingBase):
    name = "linker"

    async def work(self) -> str:
        run = self.run
        items = sorted(run.candidates.items())
        texts: dict[str, str] = {}
        for n, (idx, cands) in enumerate(items):
            idea = run.ideas[idx]
            run.progress("linking", n, len(items), f"Linking {idea.name}")
            user = f"{_idea_block(run, idea)}\n\nCandidate passages from other notes:\n\n{_candidates_block(cands)}"
            out, source = await ask(run, "linker", user, Proposals, tools=[self.read_tool()], turns=3 + LINKER_READS)
            used: set[str] = set()
            for p in out.proposals if out else []:
                ok = await self.accept(idx, p, cands, used, texts)
                if ok is not None:
                    run.found.append(Found(id=len(run.found) + 1, idea=idx, proposal=ok, source=source))
        run.progress("linking", len(items), len(items), f"{len(run.found)} possible connections")
        return f"{len(run.found)} proposals"


class JudgeNode(CodeNode):
    name = "judge"

    async def work(self) -> str:
        run = self.run
        batches = [run.found[i : i + JUDGE_BATCH] for i in range(0, len(run.found), JUDGE_BATCH)]
        for b, batch in enumerate(batches):
            run.progress("judging", b, len(batches), f"Checking {len(batch)} possible connections")
            parts = []
            for f in batch:
                idea = run.ideas[f.idea]
                p = f.proposal
                parts.append(
                    f"[{f.id}] {run.note} → {p.to_note} ({p.type})\nIdea: {idea.name}\nReason: {p.reason}\n"
                    f'Quote from {run.note}: "{p.quote_from}"\nQuote from {p.to_note}: "{p.quote_to}"'
                )
            user = "Judge these proposed connections:\n\n" + "\n\n".join(parts)
            out, _ = await ask(run, "judge", user, Verdicts)
            by_id = {f.id: f for f in batch}
            for v in out.verdicts if out else []:
                f = by_id.get(v.proposal_id)
                if f is None:
                    continue
                f.score = v.score
                f.why = v.why
                f.kept = passes(v.score, v.grounded_or_default, f.proposal.type, run.options.threshold, v.keep)
        kept = sum(f.kept for f in run.found)
        run.progress("judging", len(batches), len(batches), f"{kept} connections worth keeping")
        return f"{kept} kept"


class LiteLinkerNode(_LinkingBase):
    """Lite mode: one call per idea proposes and scores; a stricter threshold applies."""

    name = "linker"

    async def work(self) -> str:
        run = self.run
        items = sorted(run.candidates.items())
        threshold = min(run.options.threshold + LITE_STRICTER, 0.95)
        texts: dict[str, str] = {}
        for n, (idx, cands) in enumerate(items):
            idea = run.ideas[idx]
            run.progress("linking", n, len(items), f"Linking {idea.name}")
            user = f"{_idea_block(run, idea)}\n\nCandidate passages from other notes:\n\n{_candidates_block(cands)}"
            out, source = await ask(run, "lite", user, ScoredProposals)
            used: set[str] = set()
            for sp in out.proposals if out else []:
                base = Proposal.model_validate(sp.model_dump(include=set(Proposal.model_fields)))
                ok = await self.accept(idx, base, cands, used, texts)
                if ok is None:
                    continue
                f = Found(id=len(run.found) + 1, idea=idx, proposal=ok, source=source, score=sp.score)
                f.kept = passes(sp.score, sp.grounded_or_default, ok.type, threshold)
                run.found.append(f)
        kept = sum(f.kept for f in run.found)
        run.progress("linking", len(items), len(items), f"{kept} connections worth keeping")
        return f"{kept} kept"


class WriterNode(CodeNode):
    name = "writer"

    async def invoke_async(self, prompt: Any = None, **kwargs: Any) -> AgentResult:
        # The writer saves what was already judged even when the job is stopping (budget, all busy).
        summary = await self.work()
        return AgentResult(
            stop_reason="end_turn",
            message={"role": "assistant", "content": [{"text": summary}]},
            metrics=EventLoopMetrics(),
            state={},
        )

    async def work(self) -> str:
        run = self.run
        kept = sorted((f for f in run.found if f.kept), key=lambda f: f.score, reverse=True)
        chosen: list[Found] = []
        pairs: set[tuple[str, str]] = set()
        for f in kept:
            key = (f.proposal.to_note, f.proposal.type)
            if key in pairs:
                continue
            pairs.add(key)
            chosen.append(f)
            if len(chosen) >= MAX_CONNECTIONS_PER_NOTE:
                break
        if not chosen:
            run.progress("saving", 1, 1, f"No connections worth saving for {run.title}")
            return "nothing to save"
        run.progress("saving", 0, 1, f"Saving {len(chosen)} connections")
        by_source: dict[str, list[Found]] = {}
        for f in chosen:
            by_source.setdefault(f.source, []).append(f)
        status = "kept" if run.options.trust else "suggested"
        for source, group in by_source.items():
            request = {
                "connections": [self._connection(f) for f in group],
                "made_by": {"kind": "agent", "source": source, "job": run.job.job_id},
                "status": status,
            }
            try:
                report = await run.job.tools.save_connections(request)
            except ToolError as e:
                log.warning("writer | save_connections failed: %s", e)
                continue
            rejected = {r.get("index") for r in report.get("rejected", []) if isinstance(r, dict)}
            for r in report.get("rejected", []):
                log.info("writer | engine rejected a connection: %s", r.get("reason"))
            for i, f in enumerate(group):
                if i not in rejected:
                    run.saved.append(Saved(idea=f.idea, to_note=f.proposal.to_note, quote_to=f.proposal.quote_to))
            run.job.saved_connections += len(report.get("saved", []))
        self._pick_concepts()
        run.progress("saving", 1, 1, f"Saved {len(run.saved)} connections for {run.title}")
        return f"{len(run.saved)} saved"

    def _connection(self, f: Found) -> dict[str, Any]:
        p, idea = f.proposal, self.run.ideas[f.idea]
        c: dict[str, Any] = {
            "from": self.run.note,
            "to": p.to_note,
            "type": p.type,
            "reason": p.reason.strip()[:REASON_MAX],
            "quote_from": p.quote_from.strip()[:QUOTE_MAX],
            "quote_to": p.quote_to.strip()[:QUOTE_MAX],
            "confidence": round(f.score, 3),
        }
        if idea.section:
            c["from_anchor"] = "#" + idea.section.lstrip("#").strip()
        if p.to_anchor:
            c["to_anchor"] = "#" + p.to_anchor.lstrip("#").strip()
        return c

    def _pick_concepts(self) -> None:
        run = self.run
        notes_by_idea: dict[int, set[str]] = {}
        for s in run.saved:
            notes_by_idea.setdefault(s.idea, set()).add(s.to_note)
        run.concept_candidates = [
            idx
            for idx, others in sorted(notes_by_idea.items(), key=lambda kv: -len(kv[1]))
            if len(others) + 1 >= CONCEPT_MIN_NOTES
        ][:MAX_CONCEPTS_PER_NOTE]


class ConceptNode(CodeNode):
    name = "concept"

    async def work(self) -> str:
        run = self.run
        made = 0
        try:
            existing = {t.strip().lower() for t in (await run.job.tools.overview(run.collection)).get("concepts", [])}
        except (ToolError, AttributeError):
            existing = set()
        for idx in run.concept_candidates:
            idea = run.ideas[idx]
            names = {idea.name.strip().lower(), *(a.strip().lower() for a in idea.aliases)}
            if names & existing:
                continue
            run.progress("concept", made, len(run.concept_candidates), f"Writing a concept note for {idea.name}")
            saved = [s for s in run.saved if s.idea == idx]
            passages = [f'From {run.note}: "{idea.quote}"'] + [f'From {s.to_note}: "{s.quote_to}"' for s in saved]
            user = f"Idea: {idea.name}\n\nPassages:\n" + "\n".join(passages)
            out, _ = await ask(run, "concept", user, ConceptDraft)
            if out is None or out.skip or not out.title.strip() or not out.summary.strip():
                continue
            notes = [run.note, *dict.fromkeys(s.to_note for s in saved)]
            try:
                await run.job.tools.save_concept_note(
                    out.title.strip()[:80], out.summary.strip()[:1200], run.collection, notes
                )
            except ToolError as e:
                log.warning("concept | save failed: %s", e)
                continue
            made += 1
            run.job.saved_concepts += 1
        return f"{made} concepts"


def build_graph(run: NoteRun) -> Graph:
    """reader → scout → linker → judge → writer → concept (conditional); lite merges linker and judge."""
    b = GraphBuilder()
    b.add_node(ReaderNode(run), "reader")
    b.add_node(ScoutNode(run), "scout")
    b.add_edge("reader", "scout")
    if run.options.lite:
        b.add_node(LiteLinkerNode(run), "linker")
        b.add_edge("scout", "linker")
        last = "linker"
    else:
        b.add_node(LinkerNode(run), "linker")
        b.add_node(JudgeNode(run), "judge")
        b.add_edge("scout", "linker")
        b.add_edge("linker", "judge")
        last = "judge"
    b.add_node(WriterNode(run), "writer")
    b.add_edge(last, "writer")
    b.add_node(ConceptNode(run), "concept")
    b.add_edge("writer", "concept", condition=lambda _state: bool(run.concept_candidates) and not run.stopped())
    b.set_entry_point("reader")
    b.set_max_node_executions(8)
    return b.build()


async def connect_note(job: JobState, note: str) -> NoteRun:
    run = NoteRun(job=job, note=note)
    graph = build_graph(run)
    await graph.invoke_async(f"Connect the note {note}")
    return run


# --------------------------------------------------------------------------------------------------------
# Job kinds
# --------------------------------------------------------------------------------------------------------


async def run_workflow(kind: str, target: str, job: JobState, notes: list[str] | None = None) -> None:
    """Run one job. Sets `job.stop` instead of raising when the job has to pause or ran out of budget."""
    if kind == "connect_note":
        await connect_note(job, target)
    elif kind == "connect_collection":
        if notes is None:
            ov = await job.tools.overview(target)
            notes = [n["path"] for n in ov.get("notes", []) if isinstance(n, dict) and n.get("path")]
        for i, note in enumerate(notes):
            if job.stop is not None:
                break
            job.progress("note", i, len(notes), f"Note {i + 1} of {len(notes)}")
            await connect_note(job, note)
    elif kind == "connect_topic":
        hits = await job.tools.search(target, limit=12)
        notes = list(dict.fromkeys(h["path"] for h in hits if isinstance(h, dict) and h.get("path")))[:5]
        for i, note in enumerate(notes):
            if job.stop is not None:
                break
            job.progress("note", i, len(notes), f"Note {i + 1} of {len(notes)} about {target}")
            await connect_note(job, note)
        if job.stop is None and len(notes) >= CONCEPT_MIN_NOTES:
            await _topic_concept(job, target, hits, notes)
    else:
        raise ValueError(f"unknown job kind '{kind}'")


async def _topic_concept(job: JobState, topic: str, hits: list[dict[str, Any]], notes: list[str]) -> None:
    run = NoteRun(job=job, note=notes[0])
    try:
        existing = {t.strip().lower() for t in (await job.tools.overview(run.collection)).get("concepts", [])}
    except ToolError:
        existing = set()
    if topic.strip().lower() in existing:
        return
    passages = [f'From {h["path"]}: "{str(h.get("text", ""))[:600]}"' for h in hits if h.get("path") in notes]
    job.progress("concept", 0, 1, f"Writing a concept note for {topic}")
    try:
        out, _ = await ask(run, "concept", f"Idea: {topic}\n\nPassages:\n" + "\n".join(passages), ConceptDraft)
    except StopJob:
        return
    if out is None or out.skip or not out.title.strip():
        return
    try:
        await job.tools.save_concept_note(out.title.strip()[:80], out.summary.strip()[:1200], run.collection, notes)
        job.saved_concepts += 1
    except ToolError as e:
        log.warning("concept | save failed: %s", e)
