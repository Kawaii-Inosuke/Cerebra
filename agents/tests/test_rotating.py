from __future__ import annotations

import pytest
from conftest import Clock, collect, make_rotating

from cerebra_agents.rotating import (
    COOL_MAX,
    SHORT_WAIT,
    AllSourcesBusy,
    BadOutput,
    BudgetExhausted,
    classify,
    next_local_midnight,
    retry_after_seconds,
)
from cerebra_agents.sources import Caps, pick_chat_model
from cerebra_agents.testing import FakeModel, make_error


def _text(events: list) -> str:
    return "".join(e.get("contentBlockDelta", {}).get("delta", {}).get("text", "") for e in events)


async def test_rotation_moves_to_next_on_throttle():
    model, fakes, statuses, usage = make_rotating([[{"raise": "throttle"}], ["from second"]])
    events = await collect(model)
    assert _text(events) == "from second"
    assert len(fakes[0].calls) == 1 and len(fakes[1].calls) == 1
    assert model.slots[0].state == "cooling"
    assert statuses[0]["source_id"] == "s1" and statuses[0]["state"] == "cooling" and "until" in statuses[0]
    assert "rate limit" in statuses[0]["reason"]
    assert usage == [{"source_id": "s2", "requests": 1, "input_tokens": 1, "output_tokens": 2}]
    assert model.source_label == "groq:llama-3.3-70b"


async def test_first_source_is_preferred_again_after_rest():
    clock = Clock()
    model, _fakes, statuses, _ = make_rotating(
        [[{"raise": "throttle", "retry_after": 5}, "first again"], ["second", "second-2"]], clock=clock
    )
    assert _text(await collect(model)) == "second"
    assert _text(await collect(model)) == "second-2"  # s1 still resting
    clock.advance(6)
    assert _text(await collect(model)) == "first again"
    assert statuses[-1] == {"source_id": "s1", "state": "ok", "reason": ""}


async def test_auth_error_disables_source():
    model, fakes, statuses, _ = make_rotating([[{"raise": "auth"}, "never"], ["ok-1", "ok-2"]])
    assert _text(await collect(model)) == "ok-1"
    assert model.slots[0].state == "disabled"
    assert statuses[0]["state"] == "disabled"
    assert statuses[0]["reason"].startswith("Groq says the key is wrong")
    assert "until" not in statuses[0]
    assert _text(await collect(model)) == "ok-2"
    assert len(fakes[0].calls) == 1  # never tried again


async def test_cooldown_uses_retry_after_then_doubles():
    clock = Clock()
    script = [
        {"raise": "throttle", "retry_after": 7},
        {"raise": "throttle"},
        {"raise": "throttle"},
        {"raise": "throttle"},
        "success",
        {"raise": "throttle"},
    ]
    model, _, _statuses, _ = make_rotating([script, ["x"] * 10], clock=clock)
    slot = model.slots[0]
    waits = []
    for _ in range(4):
        await collect(model)
        waits.append(round(slot.until - clock.t))
        clock.advance(slot.until - clock.t + 0.1)
    assert waits == [7, 60, 120, 240]
    assert _text(await collect(model)) == "success"
    assert slot.state == "ok" and slot.auto_strikes == 0
    await collect(model)
    assert round(slot.until - clock.t) == 60  # reset after the success

    # The doubling stops at 15 minutes.
    model2, _, _, _ = make_rotating([[{"raise": "throttle"}] * 8, ["x"] * 8], clock=clock)
    waits2 = []
    for _ in range(8):
        await collect(model2)
        waits2.append(round(model2.slots[0].until - clock.t))
        clock.advance(model2.slots[0].until - clock.t + 0.1)
    assert waits2 == [60, 120, 240, 480, 900, 900, 900, 900]
    assert max(waits2) == COOL_MAX


async def test_caps_skip_source():
    clock = Clock()
    model, fakes, statuses, _ = make_rotating(
        [["never"], ["second", "second-2"]],
        clock=clock,
        caps=[Caps(requests_per_day=100), Caps()],
    )
    model.slots[0].requests = 100  # used_today at the cap
    assert _text(await collect(model)) == "second"
    assert fakes[0].calls == []
    assert statuses[0]["state"] == "capped"
    assert model.slots[0].until == next_local_midnight(clock.t)

    # Token cap reached through this job's own usage.
    model, fakes, statuses, _ = make_rotating(
        [["a" * 400, "never"], ["fallback"]], clock=clock, caps=[Caps(tokens_per_day=50), Caps()]
    )
    assert len(_text(await collect(model))) == 400
    assert _text(await collect(model)) == "fallback"
    assert len(fakes[0].calls) == 1
    assert statuses[-1]["state"] == "capped"

    # After midnight the capped source is used again.
    clock.advance(next_local_midnight(clock.t) - clock.t + 1)
    assert _text(await collect(model)) == "never"


async def test_all_busy_raises_with_next_ready_at():
    clock = Clock()
    model, _, _, _ = make_rotating(
        [[{"raise": "throttle", "retry_after": 30}], [{"raise": "throttle", "retry_after": 90}]], clock=clock
    )
    with pytest.raises(AllSourcesBusy) as info:
        await collect(model)
    assert info.value.next_ready_at == clock.t + 30

    model, _, _, _ = make_rotating([[{"raise": "auth"}]])
    with pytest.raises(AllSourcesBusy) as info:
        await collect(model)
    assert info.value.next_ready_at is None


async def test_context_overflow_skips_source_for_that_call_only():
    model, _fakes, statuses, _ = make_rotating([[{"raise": "overflow"}, "small ok"], ["big ok"]])
    assert _text(await collect(model)) == "big ok"
    assert model.slots[0].state == "ok" and statuses == []
    assert _text(await collect(model)) == "small ok"


async def test_server_errors_cool_30s_and_budget_stops():
    clock = Clock()
    model, _, _, _ = make_rotating([[{"raise": "server"}], ["ok", "ok", "ok"]], clock=clock, budget=2)
    await collect(model)
    assert round(model.slots[0].until - clock.t) == 30
    await collect(model)
    with pytest.raises(BudgetExhausted):
        await collect(model)


def test_classify_and_retry_after():
    assert classify(make_error("auth")) == "auth"
    assert classify(make_error("throttle")) == "throttle"
    assert classify(make_error("server")) == "transient"
    assert classify(make_error("unreachable")) == "unreachable"
    assert classify(make_error("not_found")) == "not_found"
    assert retry_after_seconds(make_error("throttle", 12)) == 12
    assert retry_after_seconds(Exception('quota exceeded, "retryDelay": "31s"')) == 31


async def test_bad_output_is_retried_once_and_never_rests_the_source():
    # Provider-side schema validation errors are about one answer, not about the source.
    model, fakes, statuses, _ = make_rotating([[{"raise": "bad_output"}, "fixed"], ["other"]])
    assert _text(await collect(model)) == "fixed"
    assert model.slots[0].state == "ok"
    assert len(fakes[1].calls) == 0, "the next source isn't needed"

    model, fakes, statuses, _ = make_rotating([[{"raise": "bad_output"}, {"raise": "bad_output"}, "later"], ["x"]])
    with pytest.raises(BadOutput):
        await collect(model)
    assert model.slots[0].state == "ok"
    assert statuses == []
    assert _text(await collect(model)) == "later"


async def test_short_rests_are_waited_out_long_ones_pause_the_job():
    clock = Clock()
    slept: list[float] = []

    async def fake_sleep(s: float) -> None:
        slept.append(s)
        clock.advance(s)

    model, _, _, _ = make_rotating([[{"raise": "throttle", "retry_after": 5}, "ok"]], clock=clock)
    model.sleep = fake_sleep
    assert _text(await collect(model)) == "ok"
    assert slept and 4.9 <= sum(slept) <= SHORT_WAIT

    model, _, _, _ = make_rotating([[{"raise": "throttle", "retry_after": 120}, "ok"]], clock=clock)
    model.sleep = fake_sleep
    with pytest.raises(AllSourcesBusy):
        await collect(model)


GROQ_TODAY = [
    "allam-2-7b",
    "canopylabs/orpheus-v1-english",
    "meta-llama/llama-prompt-guard-2-86m",
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "openai/gpt-oss-safeguard-20b",
    "qwen/qwen3.8-27b",
    "whisper-large-v3",
]


def test_pick_chat_model_skips_speech_guard_and_tiny_models():
    assert pick_chat_model(GROQ_TODAY) == "openai/gpt-oss-120b"
    assert pick_chat_model(["whisper-large-v3", "meta-llama/llama-prompt-guard-2-86m"]) is None
    assert pick_chat_model(["models/gemini-2.5-flash", "models/text-embedding-004"]) == "models/gemini-2.5-flash"
    assert pick_chat_model(["llama3.1:8b"]) == "llama3.1:8b"


async def test_retired_model_is_replaced_reported_and_the_call_retried():
    model, _, statuses, _ = make_rotating([[{"raise": "not_found"}]])

    async def replacer(source):
        return "openai/gpt-oss-120b", FakeModel(["answered by the new model"])

    model.replace_model = replacer
    assert _text(await collect(model)) == "answered by the new model"
    slot = model.slots[0]
    assert slot.state == "ok" and slot.source.model == "openai/gpt-oss-120b"
    assert statuses[-1]["model"] == "openai/gpt-oss-120b"
    assert "switched to openai/gpt-oss-120b" in statuses[-1]["reason"]


async def test_no_replacement_means_disabled_as_before():
    model, _, _statuses, _ = make_rotating([[{"raise": "not_found"}], ["backup"]])

    async def replacer(source):
        return None

    model.replace_model = replacer
    assert _text(await collect(model)) == "backup"
    assert model.slots[0].state == "disabled"
