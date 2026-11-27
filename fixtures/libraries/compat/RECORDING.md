# Recording what Obsidian does (black-box)

These small vaults were written by us. To check that Cerebra links notes exactly like Obsidian, open each
one in a normal Obsidian install and **write down what Obsidian's own panels show**. Never look inside
Obsidian's app files.

## How to record one fixture

1. Obsidian → *Open another vault* → *Open folder as vault* → pick the fixture folder (e.g. `F01-basic`).
2. Turn on the core plugins **Backlinks** and **Outgoing links** (Settings → Core plugins).
3. For **each note** in the fixture, open it and record:
   - **Outgoing links pane:** the linked notes, and the *unlinked/unresolved* ones (shown greyed or under "Unresolved").
   - **Backlinks pane → Linked mentions:** which notes link here.
   - **Tags pane** (fixture F10, F11 only): the tags listed.
4. Copy `engine.json` (what Cerebra produces today) to `expected.json` in the same folder, then **edit it so it
   matches what Obsidian showed**. Paths are vault-relative, like `A/Dup.md`.
5. Run `cargo test --test compat`. Any difference fails the test and shows the mismatch.

Leave `aliases` as they are. That field is not compared.

## What to look at in each fixture

| Fixture | What to check in Obsidian |
|---|---|
| F01-basic | `Start` → does each of the 4 links go to `Target`? (case and spaces) |
| F02-duplicates | Which `Dup.md` does each of `A/FromA`, `B/FromB`, `FromRoot` open when you click the link? |
| F03-paths | Which `Plan.md` each line opens. Is `[[Plan]]` (ambiguous) Biology or Physics? Is the wrong-case path resolved? |
| F04-subpaths | Do `[[#Details]]` / `[[#^para-1]]` count as links? Does `[[Doc#Nope]]` count as a link to `Doc`? |
| F05-embeds | Are embeds listed as outgoing links / backlinks? Is `nothere.png` unresolved? Do `pic.png` and `doc.pdf` appear? |
| F06-code | Which of NotLink1/2/3, **Indented**, **InComment** show `Code` as a backlink? (Only RealLink should, but indented code and comments are the open questions) |
| F07-aliases | Does `[[Nickname]]` resolve to `Real Name`, or is it unresolved? |
| F08-markdown-links | Which file each markdown link opens. Is the bare `[bare](Top.md)` resolved from inside `Sub/`? |
| F09-properties | Do `Linked From Property` and `Second` show `Props` as a backlink? |
| F10-tags | Exact tag list in the Tags pane. Is `#123` a tag (expected no)? `#year2026` (expected yes)? Anything from `a#b` or the URL? |
| F11-unicode | Do all links resolve, including lower-case `[[café plan]]`? Is `#täg` a tag? |

## Regenerate `engine.json` after code changes

```bash
for d in fixtures/libraries/compat/F*/; do
  cargo run -q -p cerebra-cli -- "$d" compat-report > "$d/engine.json"
done
```
