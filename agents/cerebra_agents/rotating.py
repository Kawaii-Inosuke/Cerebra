"""`RotatingModel`: one Strands model over every enabled AI source, in the user's order (doc 06 §5).

- Buffered: a call's events are collected before being passed on, so a source failing half-way never leaves
  a half answer; the call just moves on to the next source.
- Throttled (429 / quota): cool down for Retry-After when given, else 60 s doubling per repeat up to 15 min;
  reset after a success.
- Bad key (401/403): the source is disabled for the rest of the job.
- Daily caps: a source at its request or token cap is skipped until local midnight.
- Context too small: that source is skipped for this call only.
- Timeouts / server errors: 30 s cool-down.
- Nothing ready: `AllSourcesBusy(next_ready_at)`, which pauses the job.
- Per-job budget: `BudgetExhausted` once `budget` successful calls were made.
"""

from __future__ import annotations

import asyncio
import email.utils
import logging
import re
import time
from collections.abc import AsyncGenerator, AsyncIterable, Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Literal

from strands.models import Model
from strands.types.exceptions import ContextWindowOverflowException, ModelThrottledException

from .protocol import redact
from .sources import Source

log = logging.getLogger(__name__)

COOL_BASE = 60.0
COOL_MAX = 15 * 60.0
COOL_TRANSIENT = 30.0

SlotState = Literal["ok", "cooling", "disabled", "capped"]
ErrorKind = Literal["throttle", "auth", "overflow", "transient", "not_found", "unreachable", "bad_output", "other"]

# Provider-side checks of the model's own answer (e.g. Groq validating a tool call against the schema).
# They are about one answer, never about the source, so they must not rest or disable it.
BAD_OUTPUT_MARKERS = (
    "tool call validation failed",
    "tool_use_failed",
    "did not match schema",
    "failed to call a function",
    "failed_generation",
)


class AllSourcesBusy(Exception):
    """No source can take a call right now. `next_ready_at` is an epoch time, or None if none ever will."""

    def __init__(self, next_ready_at: float | None, reason: str) -> None:
        super().__init__(reason)
        self.next_ready_at = next_ready_at
        self.reason = reason


# When every source is resting for at most this long, wait inside the job instead of pausing it.
SHORT_WAIT = 20.0


class BadOutput(Exception):
    """The model's answer was rejected by the provider's own format check, twice. Skip this step."""


class BudgetExhausted(Exception):
    """The per-job model-call budget is used up."""


def iso(ts: float | None) -> str | None:
    if ts is None:
        return None
    return datetime.fromtimestamp(ts).astimezone().isoformat(timespec="seconds")


def next_local_midnight(now: float) -> float:
    local = datetime.fromtimestamp(now).astimezone()
    tomorrow = (local + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return tomorrow.timestamp()


# --------------------------------------------------------------------------------------------------------
# Error classification
# --------------------------------------------------------------------------------------------------------


def _chain(e: BaseException) -> list[BaseException]:
    out: list[BaseException] = []
    cur: BaseException | None = e
    while cur is not None and cur not in out and len(out) < 6:
        out.append(cur)
        cur = cur.__cause__ or cur.__context__
    return out


def _status_of(e: BaseException) -> int | None:
    for attr in ("status_code", "status", "code", "http_status"):
        v = getattr(e, attr, None)
        if isinstance(v, int) and 100 <= v < 600:
            return v
    resp = getattr(e, "response", None)
    v = getattr(resp, "status_code", None)
    if isinstance(v, int):
        return v
    return None


def _headers_of(e: BaseException) -> Any:
    resp = getattr(e, "response", None)
    headers = getattr(resp, "headers", None)
    if headers is None:
        headers = getattr(e, "headers", None)
    return headers


_RETRY_IN_RE = re.compile(
    r"(?:retry(?:[ _-]?after|[ _-]?delay)?\D{0,12}?|try again in )(\d+(?:\.\d+)?)\s*(ms|s\b)?", re.IGNORECASE
)


def retry_after_seconds(e: BaseException) -> float | None:
    """Seconds the provider asked us to wait, from Retry-After headers or the error text."""
    for exc in _chain(e):
        direct = getattr(exc, "retry_after", None)
        if isinstance(direct, (int, float)) and direct >= 0:
            return float(direct)
        headers = _headers_of(exc)
        if headers is not None:
            try:
                ms = headers.get("retry-after-ms")
                if ms is not None:
                    return float(ms) / 1000.0
                ra = headers.get("retry-after")
            except Exception:
                ra = None
            if ra is not None:
                try:
                    return max(0.0, float(ra))
                except ValueError:
                    parsed = email.utils.parsedate_to_datetime(str(ra))
                    if parsed is not None:
                        return max(0.0, parsed.timestamp() - time.time())
    m = _RETRY_IN_RE.search(" ".join(str(x) for x in _chain(e)))
    if m:
        value = float(m.group(1))
        return value / 1000.0 if (m.group(2) or "").lower() == "ms" else value
    return None


def classify(e: BaseException) -> ErrorKind:
    chain = _chain(e)
    names = " ".join(type(x).__name__ for x in chain)
    text = " ".join(str(x) for x in chain).lower()
    statuses = [s for s in (_status_of(x) for x in chain) if s is not None]
    status = statuses[0] if statuses else None

    if any(isinstance(x, ContextWindowOverflowException) for x in chain):
        return "overflow"
    if any(k in text for k in BAD_OUTPUT_MARKERS):
        return "bad_output"
    if (
        any(isinstance(x, ModelThrottledException) for x in chain)
        or status == 429
        or any(k in text for k in ("rate limit", "rate_limit", "quota", "resource_exhausted", "too many requests"))
    ):
        return "throttle"
    if (
        status in (401, 403)
        or "AuthenticationError" in names
        or "PermissionDenied" in names
        or any(
            k in text
            for k in (
                "invalid api key",
                "api key not valid",
                "incorrect api key",
                "invalid x-api-key",
                "unauthorized",
                "invalid_api_key",
                "api_key_invalid",
            )
        )
    ):
        return "auth"
    if status == 404 or ("model" in text and any(k in text for k in ("not found", "does not exist", "no such"))):
        return "not_found"
    if (
        any(isinstance(x, (ConnectionError, ConnectionRefusedError)) for x in chain)
        or any(k in names for k in ("ConnectError", "APIConnectionError", "ConnectionError"))
        or any(
            k in text
            for k in (
                "connection refused",
                "connect error",
                "name or service not known",
                "failed to establish",
                "nodename nor servname",
            )
        )
    ):
        return "unreachable"
    if (
        (status is not None and status >= 500)
        or any(isinstance(x, (TimeoutError, asyncio.TimeoutError)) for x in chain)
        or any(k in names for k in ("Timeout", "ServiceUnavailable", "InternalServer", "Overloaded"))
    ):
        return "transient"
    return "other"


def plain_error(source: Source, e: BaseException) -> str:
    """A sentence a non-technical user can act on. Never contains the key."""
    name = source.name
    kind = classify(e)
    if kind == "auth":
        return f"{name} says the key is wrong. Check that you pasted the whole key."
    if kind == "throttle":
        wait = retry_after_seconds(e)
        when = f" Try again in about {round(wait)} seconds." if wait else " Try again in a minute."
        return f"{name} says you've hit its rate limit or free quota.{when}"
    if kind == "not_found":
        return f"{name} doesn't know the model '{source.model}'. Check the model name."
    if kind == "unreachable":
        where = source.endpoint or name
        if source.local:
            return f"Couldn't reach {name} at {where}. Is it running?"
        return f"Couldn't reach {name} at {where}. Check your internet connection."
    if kind == "overflow":
        return f"{name} says the request is too long for '{source.model}'."
    if kind == "transient":
        return f"{name} didn't answer in time or had a server problem. Try again shortly."
    detail = redact(str(e)).strip().splitlines()[0][:200] if str(e).strip() else type(e).__name__
    return f"{name} returned an error: {detail}"


# --------------------------------------------------------------------------------------------------------
# Slots and the rotating model
# --------------------------------------------------------------------------------------------------------


@dataclass
class SourceSlot:
    source: Source
    model: Model
    state: SlotState = "ok"
    until: float | None = None
    reason: str = ""
    auto_strikes: int = 0  # throttles without Retry-After since the last success
    requests: int = 0
    tokens: int = 0
    reported: SlotState = field(default="ok")
    replaced: bool = False  # already swapped a retired model once in this job

    def __post_init__(self) -> None:
        self.requests = self.source.used_requests
        self.tokens = self.source.used_tokens

    @property
    def id(self) -> str:
        return self.source.id

    def at_cap(self) -> bool:
        caps = self.source.caps
        return (caps.requests_per_day is not None and self.requests >= caps.requests_per_day) or (
            caps.tokens_per_day is not None and self.tokens >= caps.tokens_per_day
        )


StatusCallback = Callable[[dict[str, Any]], None]
UsageCallback = Callable[[dict[str, Any]], None]


class RotatingModel(Model):
    """A Strands `Model` that tries each source in order and rotates on limits and failures."""

    def __init__(
        self,
        slots: list[SourceSlot],
        on_status: StatusCallback | None = None,
        on_usage: UsageCallback | None = None,
        *,
        budget: int | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.slots = slots
        self._on_status = on_status or (lambda _p: None)
        self._on_usage = on_usage or (lambda _p: None)
        self.budget = budget
        self.calls = 0
        self.clock = clock
        self.sleep: Callable[[float], Awaitable[None]] = asyncio.sleep
        # Called when a provider says the model doesn't exist: returns (new model id, model) or None.
        self.replace_model: Callable[[Source], Awaitable[tuple[str, Model] | None]] | None = None
        self.last_slot: SourceSlot | None = None
        self._config: dict[str, Any] = {"model_id": "cerebra-rotating"}

    # -- Model interface -------------------------------------------------------------------------------

    def update_config(self, **model_config: Any) -> None:
        self._config.update(model_config)

    def get_config(self) -> dict[str, Any]:
        return dict(self._config)

    async def stream(  # type: ignore[override]
        self,
        messages: Any,
        tool_specs: Any = None,
        system_prompt: str | None = None,
        **kwargs: Any,
    ) -> AsyncGenerator[Any, None]:
        events = await self._rotate(lambda m: m.stream(messages, tool_specs, system_prompt, **kwargs))
        for event in events:
            yield event

    async def structured_output(  # type: ignore[override]
        self, output_model: Any, prompt: Any, system_prompt: str | None = None, **kwargs: Any
    ) -> AsyncGenerator[Any, None]:
        events = await self._rotate(lambda m: m.structured_output(output_model, prompt, system_prompt, **kwargs))
        for event in events:
            yield event

    # -- rotation --------------------------------------------------------------------------------------

    @property
    def source_label(self) -> str:
        """`provider:model` of the source that answered last (or the first one)."""
        slot = self.last_slot or (self.slots[0] if self.slots else None)
        return slot.source.label if slot else "unknown"

    def budget_left(self) -> int | None:
        return None if self.budget is None else max(0, self.budget - self.calls)

    async def _rotate(self, call: Callable[[Model], AsyncIterable[Any]]) -> list[Any]:
        if self.budget is not None and self.calls >= self.budget:
            raise BudgetExhausted(f"used the job budget of {self.budget} model calls")
        for _ in range(6):
            try:
                return await self._rotate_once(call)
            except AllSourcesBusy as busy:
                wait = None if busy.next_ready_at is None else busy.next_ready_at - self.clock()
                if wait is None or wait > SHORT_WAIT:
                    raise
                log.info("all sources resting for %.0f s, waiting", max(wait, 0))
                await self.sleep(max(wait, 0.05))
        return await self._rotate_once(call)

    async def _rotate_once(self, call: Callable[[Model], AsyncIterable[Any]]) -> list[Any]:
        overflowed = False
        for slot in self.slots:
            if not self._ready(slot):
                continue
            try:
                try:
                    events = [e async for e in call(slot.model)]
                except Exception as e:
                    if classify(e) != "bad_output":
                        raise
                    log.info("source=%s | the answer didn't match the expected format, asking again", slot.id)
                    try:
                        events = [e async for e in call(slot.model)]
                    except Exception as e2:
                        if classify(e2) == "bad_output":
                            log.info("source=%s | rejected answer: %s", slot.id, str(e2)[:400])
                            raise BadOutput("the model's answer didn't match the expected format") from e2
                        raise
            except (asyncio.CancelledError, BadOutput):
                raise
            except Exception as e:
                if classify(e) == "not_found" and self.replace_model is not None and not slot.replaced:
                    slot.replaced = True
                    found = await self.replace_model(slot.source)
                    if found is not None:
                        old = slot.source.model
                        slot.source.model, slot.model = found
                        slot.state, slot.until = "ok", None
                        slot.reason = f"{slot.source.name} no longer offers {old}; switched to {found[0]}"
                        log.warning("source=%s | %s", slot.id, slot.reason)
                        self._report(slot, model=found[0])
                        return await self._rotate_once(call)
                if classify(e) == "overflow":
                    overflowed = True
                    log.info("source=%s | request too large for this model, trying the next", slot.id)
                    continue
                self._fail(slot, e)
                continue
            self._succeed(slot, events)
            return events
        if overflowed:
            raise ContextWindowOverflowException("the request is too large for every available source")
        nxt = self.next_ready_at()
        if nxt is None:
            raise AllSourcesBusy(None, "No AI source is working. Check the keys on the AI sources screen.")
        raise AllSourcesBusy(nxt, "All AI sources are resting.")

    def next_ready_at(self) -> float | None:
        times = [s.until for s in self.slots if s.state in ("cooling", "capped") and s.until is not None]
        return min(times) if times else None

    def _ready(self, slot: SourceSlot) -> bool:
        now = self.clock()
        if slot.state == "disabled":
            return False
        if slot.state in ("cooling", "capped") and slot.until is not None and now < slot.until:
            return False
        if slot.state == "capped":  # a new day has begun
            slot.requests = slot.tokens = 0
            slot.state, slot.until = "ok", None
        if slot.state == "cooling":
            slot.state, slot.until = "ok", None
        if slot.at_cap():
            slot.state, slot.until, slot.reason = "capped", next_local_midnight(now), "Daily limit reached."
            self._report(slot)
            return False
        return True

    def _succeed(self, slot: SourceSlot, events: list[Any]) -> None:
        self.calls += 1
        self.last_slot = slot
        slot.auto_strikes = 0
        slot.state, slot.until, slot.reason = "ok", None, ""
        usage: dict[str, Any] = {}
        for e in events:
            if isinstance(e, dict) and "metadata" in e:
                usage = e["metadata"].get("usage") or usage
        inp = int(usage.get("inputTokens") or 0)
        out = int(usage.get("outputTokens") or 0)
        slot.requests += 1
        slot.tokens += inp + out
        self._on_usage({"source_id": slot.id, "requests": 1, "input_tokens": inp, "output_tokens": out})
        if slot.reported != "ok":
            self._report(slot)

    def _fail(self, slot: SourceSlot, e: BaseException) -> None:
        kind = classify(e)
        now = self.clock()
        reason = plain_error(slot.source, e)
        if kind == "auth" or kind == "not_found":
            slot.state, slot.until = "disabled", None
        elif kind == "throttle":
            wait = retry_after_seconds(e)
            if wait is None:
                slot.auto_strikes += 1
                wait = min(COOL_BASE * 2 ** (slot.auto_strikes - 1), COOL_MAX)
            slot.state, slot.until = "cooling", now + min(wait, 24 * 3600)
        else:  # transient, unreachable, other
            slot.auto_strikes += 1
            wait = min(COOL_TRANSIENT * 2 ** (slot.auto_strikes - 1), COOL_MAX)
            slot.state, slot.until = "cooling", now + wait
        slot.reason = reason
        log.warning("source=%s state=%s | %s", slot.id, slot.state, reason)
        self._report(slot)

    def _report(self, slot: SourceSlot, model: str | None = None) -> None:
        slot.reported = slot.state
        payload: dict[str, Any] = {"source_id": slot.id, "state": slot.state, "reason": slot.reason}
        if model is not None:
            payload["model"] = model  # the app saves the new model on the source
        if slot.until is not None:
            payload["until"] = iso(slot.until)
        self._on_status(payload)
