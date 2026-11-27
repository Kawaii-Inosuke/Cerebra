"""Structured outputs of the LLM nodes (doc 06 §3) and the rubric maths (doc 06 §4).

Field descriptions are sent to the model as part of the structured-output tool schema, so they double as
instructions. Limits that a model may overshoot (number of ideas, text length) are enforced in code after
validation rather than in the schema, so a slightly long answer is trimmed instead of thrown away.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

ConnectionType = Literal[
    "explains", "builds_on", "example_of", "contrasts", "same_concept", "cause_effect", "part_of", "related"
]
CONNECTION_TYPES: tuple[str, ...] = (
    "explains",
    "builds_on",
    "example_of",
    "contrasts",
    "same_concept",
    "cause_effect",
    "part_of",
    "related",
)
IdeaKind = Literal["definition", "process", "fact", "argument", "example", "formula"]

REASON_MAX = 600
QUOTE_MAX = 400

# Rubric weights (doc 06 §4).
W_GROUNDED, W_SPECIFIC, W_USEFUL, W_NEW = 0.35, 0.25, 0.25, 0.15
THRESHOLDS = {"strict": 0.75, "balanced": 0.6, "generous": 0.45}
RELATED_MIN = 0.75
GROUNDED_MIN = 0.5


class Idea(BaseModel):
    name: str = Field(description="Short name of the idea, as the note words it.")
    aliases: list[str] = Field(default_factory=list, description="Other names the note uses for it.")
    kind: IdeaKind = Field(default="fact", description="definition, process, fact, argument, example or formula.")
    section: str = Field(default="", description="Heading of the section it comes from ('' if none).")
    quote: str = Field(description="A sentence copied exactly, word for word, from the note that states it.")


class Ideas(BaseModel):
    """The key ideas of one note."""

    ideas: list[Idea] = Field(default_factory=list, description="The most important ideas, best first.")


class Proposal(BaseModel):
    to_note: str = Field(description="Path of the other note, exactly as given in the candidates.")
    to_anchor: str | None = Field(default=None, description="Heading in the other note, if one fits.")
    type: ConnectionType = Field(description="How this note relates to the other note.")
    reason: str = Field(description="One or two sentences a student would find useful. Name the shared idea.")
    quote_from: str = Field(description="Exact words copied from THIS note that support the connection.")
    quote_to: str = Field(description="Exact words copied from the OTHER note's passage that support it.")


class Proposals(BaseModel):
    """Proposed connections for one idea. An empty list is a good answer when nothing is strong."""

    proposals: list[Proposal] = Field(default_factory=list)


class _Rubric(BaseModel):
    """The judge's four rubric scores. Optional: some providers' models leave them out, and that must not
    throw the answer away. A missing score counts as MISSING_SCORE (cautious: passes "balanced" only when
    the model also says keep; never "strict", never `related`). Quotes are checked in code regardless."""

    grounded: float | None = Field(
        default=None, ge=0, le=1, description="0-1: do both quotes really support the claim?"
    )
    specific: float | None = Field(
        default=None, ge=0, le=1, description="0-1: does it name the shared idea and how they relate?"
    )
    useful: float | None = Field(
        default=None, ge=0, le=1, description="0-1: does it help understand, revise or decide something?"
    )
    new: float | None = Field(
        default=None, ge=0, le=1, description="0-1: is it new (not already linked, not the same source)?"
    )

    @property
    def grounded_or_default(self) -> float:
        return MISSING_SCORE if self.grounded is None else self.grounded

    @property
    def score(self) -> float:
        d = lambda x: MISSING_SCORE if x is None else x  # noqa: E731
        return weighted_score(d(self.grounded), d(self.specific), d(self.useful), d(self.new))


class Verdict(_Rubric):
    proposal_id: int = Field(description="The number of the proposal being judged.")
    keep: bool = Field(description="Would you keep this connection?")
    why: str = Field(default="", description="One short sentence.")


class Verdicts(BaseModel):
    """One verdict per proposal."""

    verdicts: list[Verdict] = Field(default_factory=list)


class ScoredProposal(_Rubric, Proposal):
    """Lite mode: the linker proposes and judges in one step."""


class ScoredProposals(BaseModel):
    """Proposed and self-judged connections for one idea. Empty is a good answer when nothing is strong."""

    proposals: list[ScoredProposal] = Field(default_factory=list)


class ConceptDraft(BaseModel):
    """A concept note for an idea that several notes share."""

    skip: bool = Field(default=False, description="True if the notes don't really share one idea.")
    title: str = Field(default="", description="Name of the concept, 1-5 words.")
    summary: str = Field(default="", description="2-4 sentences, using only the given passages.")


MISSING_SCORE = 0.65


def weighted_score(grounded: float, specific: float, useful: float, new: float) -> float:
    return round(W_GROUNDED * grounded + W_SPECIFIC * specific + W_USEFUL * useful + W_NEW * new, 4)


def threshold_value(setting: object) -> float:
    """`strict`/`balanced`/`generous` or a number; anything else means balanced."""
    if isinstance(setting, (int, float)) and not isinstance(setting, bool):
        return min(max(float(setting), 0.0), 1.0)
    if isinstance(setting, str):
        key = setting.strip().lower()
        if key in THRESHOLDS:
            return THRESHOLDS[key]
        try:
            return min(max(float(key), 0.0), 1.0)
        except ValueError:
            pass
    return THRESHOLDS["balanced"]


def passes(score: float, grounded: float, type_: str, threshold: float, model_keep: bool = True) -> bool:
    """The keep rule: model agrees, grounded enough, above threshold; `related` needs ≥ 0.75."""
    if not model_keep or grounded < GROUNDED_MIN:
        return False
    need = max(threshold, RELATED_MIN) if type_ == "related" else threshold
    return score >= need
