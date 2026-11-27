from __future__ import annotations

from cerebra_agents.schemas import Idea, ScoredProposal, Verdict, passes

BALANCED, STRICT = 0.6, 0.75


def test_verdict_without_rubric_scores_is_accepted_cautiously():
    # Some providers' models answer with only keep/why; that must not throw the answer away.
    v = Verdict.model_validate({"proposal_id": 1, "keep": True, "why": "clear"})
    assert passes(v.score, v.grounded_or_default, "explains", BALANCED, v.keep)
    assert not passes(v.score, v.grounded_or_default, "explains", STRICT, v.keep)
    assert not passes(v.score, v.grounded_or_default, "related", BALANCED, v.keep), "related needs 0.75"
    no = Verdict.model_validate({"proposal_id": 1, "keep": False})
    assert not passes(no.score, no.grounded_or_default, "explains", BALANCED, no.keep)


def test_partial_scores_use_the_ones_given():
    v = Verdict.model_validate({"proposal_id": 2, "keep": True, "grounded": 1, "specific": 1, "useful": 1, "new": 1})
    assert v.score == 1.0
    low = Verdict.model_validate({"proposal_id": 2, "keep": True, "grounded": 0.2})
    assert not passes(low.score, low.grounded_or_default, "explains", BALANCED, low.keep)


def test_scored_proposal_and_idea_defaults():
    sp = ScoredProposal.model_validate(
        {"to_note": "a.md", "type": "explains", "reason": "r", "quote_from": "x", "quote_to": "y"}
    )
    assert passes(sp.score, sp.grounded_or_default, sp.type, BALANCED)
    assert Idea.model_validate({"name": "osmosis", "quote": "q"}).kind == "fact"
