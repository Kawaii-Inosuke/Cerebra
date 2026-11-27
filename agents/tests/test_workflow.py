from __future__ import annotations

from conftest import LIBRARY, NOTE_A, NOTE_B, NOTE_C, NOTE_D, cand, job_state, make_rotating

from cerebra_agents.rotating import BudgetExhausted
from cerebra_agents.tools import FakeTools
from cerebra_agents.workflow import connect_note

MEMBRANE = {
    "name": "selectively permeable membrane",
    "kind": "definition",
    "section": "Membrane",
    "quote": "The cell membrane is selectively permeable",
}
MITO = {
    "name": "mitochondria",
    "kind": "fact",
    "section": "Mitochondria",
    "quote": "Mitochondria release energy from glucose during respiration.",
}
IDEAS = {"ideas": [MEMBRANE, MITO]}

P_B = {
    "to_note": NOTE_B,
    "type": "explains",
    "reason": "Osmosis depends on the membrane permeability defined in Cell Structure.",
    "quote_from": "The cell membrane is selectively permeable, letting water through",
    "quote_to": "Osmosis is the movement of water across a semi-permeable membrane",
}
P_C = {
    "to_note": NOTE_C,
    "type": "explains",
    "reason": "Root hair cells absorb water because of the permeable membrane.",
    "quote_from": "The cell membrane is selectively permeable",
    "quote_to": "Root hair cells take up water by osmosis because the membrane is selectively permeable.",
}
P_D = {
    "to_note": NOTE_D,
    "type": "related",
    "reason": "Kidneys also rely on permeable membranes.",
    "quote_from": "The cell membrane is selectively permeable",
    "quote_to": "The kidney nephron reabsorbs water through a selectively permeable membrane.",
}
P_C_MITO = {
    "to_note": NOTE_C,
    "type": "builds_on",
    "reason": "Respiration in mitochondria uses the glucose plants make.",
    "quote_from": "Mitochondria release energy from glucose during respiration.",
    "quote_to": "Plants use glucose made in photosynthesis.",
}


def verdict(pid: int, s: float, keep: bool = True) -> dict:
    return {"proposal_id": pid, "grounded": s, "specific": s, "useful": s, "new": s, "keep": keep, "why": "."}


def tools() -> FakeTools:
    return FakeTools(
        LIBRARY,
        candidates={
            MEMBRANE["name"]: [cand(NOTE_B), cand(NOTE_C), cand(NOTE_D)],
            MITO["name"]: [cand(NOTE_C)],
        },
    )


def tool_calls(fake) -> list[str]:
    return [c["tool"] for c in fake.calls]


async def test_workflow_saves_only_kept_proposals():
    script = {
        "Ideas": [IDEAS],
        "Proposals": [{"proposals": [P_B, P_C, P_D]}, {"proposals": [P_C_MITO]}],
        "Verdicts": [
            {
                "verdicts": [
                    verdict(1, 0.9),  # kept
                    verdict(2, 0.5),  # below the 0.6 threshold
                    verdict(3, 0.7),  # `related` needs 0.75
                    verdict(4, 0.95, keep=False),  # the judge said no
                ]
            }
        ],
    }
    model, fakes, _, usage = make_rotating([script])
    lib = tools()
    state, progress = job_state(model, lib)
    run = await connect_note(state, NOTE_A)

    assert tool_calls(fakes[0]) == ["Ideas", "Proposals", "Proposals", "Verdicts"]
    assert len(lib.saved_requests) == 1
    req = lib.saved_requests[0]
    assert req["status"] == "suggested"
    assert req["made_by"] == {"kind": "agent", "source": "groq:llama-3.3-70b", "job": "j_1"}
    [conn] = req["connections"]
    assert conn["from"] == NOTE_A and conn["to"] == NOTE_B and conn["type"] == "explains"
    assert conn["from_anchor"] == "#Membrane"
    assert conn["confidence"] == 0.9
    assert state.saved_connections == 1 and run.concept_candidates == []
    assert {p[0] for p in progress} >= {"reading", "finding", "linking", "judging", "saving"}
    assert len(usage) == 4


async def test_trust_saves_as_kept_and_concept_runs_for_shared_idea():
    script = {
        "Ideas": [IDEAS],
        "Proposals": [{"proposals": [P_B, P_C]}, {}],
        "Verdicts": [{"verdicts": [verdict(1, 0.9), verdict(2, 0.8)]}],
        "ConceptDraft": [{"title": "Selective permeability", "summary": "Membranes let water through."}],
    }
    model, fakes, _, _ = make_rotating([script])
    lib = tools()
    state, _ = job_state(model, lib, trust=True)
    await connect_note(state, NOTE_A)
    assert lib.saved_requests[0]["status"] == "kept"
    assert len(lib.saved) == 2
    assert lib.concepts == [
        {
            "id": "k_1",
            "title": "Selective permeability",
            "summary": "Membranes let water through.",
            "collection": "Biology",
            "notes": [NOTE_A, NOTE_B, NOTE_C],
        }
    ]
    assert tool_calls(fakes[0])[-1] == "ConceptDraft"
    assert state.saved_concepts == 1


async def test_invalid_structured_output_is_skipped():
    bad = {"proposals": [{"to_note": NOTE_B, "type": "is-like"}]}  # missing fields, bad type
    invented = dict(P_C, quote_to="Plants are basically tiny kidneys.")  # quote not in the note
    script = {
        "Ideas": [IDEAS],
        "Proposals": [bad, bad, {"proposals": [P_C_MITO, invented]}],
        "Verdicts": [{"verdicts": [verdict(1, 0.9)]}],
    }
    model, fakes, _, _ = make_rotating([script])
    lib = tools()
    state, _ = job_state(model, lib)
    run = await connect_note(state, NOTE_A)

    # Idea 1: first answer invalid, one repair retry also invalid → skipped. Idea 2 continues.
    assert tool_calls(fakes[0]) == ["Ideas", "Proposals", "Proposals", "Proposals", "Verdicts"]
    assert [f.proposal.to_note for f in run.found] == [NOTE_C]  # the invented quote never reached the judge
    [conn] = lib.saved_requests[0]["connections"]
    assert conn["type"] == "builds_on" and conn["to"] == NOTE_C


async def test_plain_text_json_answer_is_accepted():
    # A model without tool calling answers with JSON text on the forced retry.
    import json

    script = ["I think the ideas are...", json.dumps({"ideas": [MEMBRANE]})]
    model, _, _, _ = make_rotating([script])
    state, _ = job_state(model, FakeTools(LIBRARY))
    run = await connect_note(state, NOTE_A)
    assert [i.name for i in run.ideas] == [MEMBRANE["name"]]


async def test_lite_mode_merges_linker_and_judge():
    def scored(p: dict, s: float) -> dict:
        return {**p, "grounded": s, "specific": s, "useful": s, "new": s}

    script = {
        "Ideas": [IDEAS],
        # 0.65 would pass "balanced" (0.6) but lite mode is stricter (+0.1).
        "ScoredProposals": [{"proposals": [scored(P_B, 0.9), scored(P_C, 0.65)]}, {}],
    }
    model, fakes, _, _ = make_rotating([script])
    lib = tools()
    state, _ = job_state(model, lib, lite=True)
    await connect_note(state, NOTE_A)
    assert tool_calls(fakes[0]) == ["Ideas", "ScoredProposals", "ScoredProposals"]
    assert "at most 6 ideas" in fakes[0].calls[0]["system"]
    [conn] = lib.saved_requests[0]["connections"]
    assert conn["to"] == NOTE_B and conn["confidence"] == 0.9


async def test_full_mode_reader_asks_for_twelve_ideas():
    model, fakes, _, _ = make_rotating([{"Ideas": [{"ideas": []}]}])
    state, _ = job_state(model, tools())
    await connect_note(state, NOTE_A)
    assert "at most 12 ideas" in fakes[0].calls[0]["system"]
    assert tool_calls(fakes[0]) == ["Ideas"]  # nothing to link, no further calls


async def test_budget_stops_cleanly_and_saves_nothing_half_judged():
    script = {"Ideas": [IDEAS], "Proposals": [{"proposals": [P_B]}]}
    model, fakes, _, _ = make_rotating([script], budget=2)
    lib = tools()
    state, _ = job_state(model, lib)
    await connect_note(state, NOTE_A)
    assert isinstance(state.stop, BudgetExhausted)
    assert tool_calls(fakes[0]) == ["Ideas", "Proposals"]
    assert lib.saved_requests == []
