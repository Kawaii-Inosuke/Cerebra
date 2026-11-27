# Evaluating the agents

Status: **placeholder**. No numbers yet; this page describes the method (doc 06 §8) so results can be
compared between prompt and threshold changes.

## Data

- Library: `fixtures/libraries/biology-small` (20 notes written for the project).
- Labels: `agents/eval/biology-small.json`, a hand-made list of good connections
  `{from, to, type?}` (direction-insensitive for symmetric types: `contrasts`, `same_concept`, `related`).

## Method

1. Start from an empty AI layer (`.cerebra/ai-layer.json` removed or a copy of the library).
2. Run `connect_collection` over the library with one source and record the source and model, the
   threshold (strict / balanced / generous), lite mode on/off, and the prompt versions
   (first line of each file in `cerebra_agents/prompts/`).
3. Take every saved connection (status `suggested` or `kept`).
4. Score against the labels:
   - **precision** = saved connections that match a label / all saved connections
   - **recall** = labels matched by a saved connection / all labels
   - a match is the same pair of notes; the type is reported separately as type accuracy.
5. Also record: model calls, input/output tokens, connections rejected by the engine (by reason, from the
   logs), and run time.

Precision matters more than recall: the agents should prefer no connection over a weak one. The target
for the default (balanced) setting is precision ≥ 0.8.

## Results

| Date | Source / model | Mode | Threshold | Prompts | Precision | Recall | Calls | Notes |
|---|---|---|---|---|---|---|---|---|
| – | – | – | – | – | – | – | – | not run yet |
