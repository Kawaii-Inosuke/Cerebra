//! Finding the right passages for a question (Copy context and the AI connector's search).
//!
//! 1. **Names**: notes whose title the question mentions ("unit 1" → "UNIT 1 SNA"; numbers
//!    match as digits, roman numerals or glued: "unit 4" = "Unit IV" = "unit4").
//!    "What is X about?" questions get that note's **outline**.
//! 2. **Hybrid search**: keyword search (SQLite FTS5, BM25) and search by meaning
//!    (`semantic.rs`), merged with Reciprocal Rank Fusion; passages of named notes get a boost.
//! 3. **Re-ranking**: a cross-encoder model scores the top candidates against the question.
//!
//! Approach after qmd (github.com/tobi/qmd, MIT): BM25 + vectors + RRF + rerank. Everything
//! runs on this computer; without the models it falls back to names + keywords.

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::collection::collection_of;
use crate::semantic;
use crate::store::{ChunkRow, Store};
use crate::vault::Vault;

const STOPWORDS: &[&str] = &[
    "a", "about", "after", "all", "also", "an", "and", "any", "are", "as", "at", "be", "been", "but", "by",
    "can", "could", "did", "do", "does", "for", "from", "give", "had", "has", "have", "how", "i", "if", "in",
    "into", "is", "it", "its", "me", "my", "of", "on", "or", "our", "please", "should", "so", "tell", "than",
    "that", "the", "their", "them", "then", "there", "these", "they", "this", "those", "to", "us", "was",
    "we", "were", "what", "when", "where", "which", "who", "whom", "why", "will", "with", "would", "you",
    "your", "explain", "describe",
];

const OVERVIEW_WORDS: &[&str] = &[
    "about",
    "overview",
    "summary",
    "summarise",
    "summarize",
    "outline",
    "topics",
    "contents",
    "covered",
    "covers",
    "cover",
    "explain",
    "describe",
    "brief",
    "gist",
    "main",
    "intro",
    "introduction",
];

/// Words after which a roman numeral is a number ("Unit IV").
const COUNTED: &[&str] = &[
    "unit", "chapter", "part", "module", "week", "lecture", "lesson", "section", "phase", "sprint", "volume",
    "book", "session", "round", "stage", "level", "q", "quarter", "day", "step", "page", "slide",
];

pub fn is_stopword(w: &str) -> bool {
    STOPWORDS.contains(&w)
}

fn roman(s: &str) -> Option<u32> {
    let val = |c| match c {
        'i' => Some(1),
        'v' => Some(5),
        'x' => Some(10),
        'l' => Some(50),
        _ => None,
    };
    let digits: Vec<u32> = s.chars().map(val).collect::<Option<_>>()?;
    let mut total = 0i64;
    for (i, d) in digits.iter().enumerate() {
        if digits.get(i + 1).is_some_and(|n| n > d) {
            total -= *d as i64;
        } else {
            total += *d as i64;
        }
    }
    (1..=60).contains(&total).then_some(total as u32)
}

/// Lowercase words, with letters and digits split ("unit4" → "unit 4"), leading zeros dropped,
/// and roman numerals after counting words turned into digits ("unit iv" → "unit 4").
pub fn words(s: &str) -> Vec<String> {
    let mut spaced = String::with_capacity(s.len() + 8);
    let mut prev: Option<char> = None;
    for c in s.chars() {
        if let Some(p) = prev
            && ((p.is_alphabetic() && c.is_ascii_digit()) || (p.is_ascii_digit() && c.is_alphabetic()))
        {
            spaced.push(' ');
        }
        spaced.push(if c.is_alphanumeric() {
            c.to_ascii_lowercase()
        } else {
            ' '
        });
        prev = Some(c);
    }
    let raw: Vec<String> = spaced.split_whitespace().map(|w| w.to_lowercase()).collect();
    let mut out: Vec<String> = Vec::with_capacity(raw.len());
    for w in raw {
        let after_counted = out.last().is_some_and(|p| COUNTED.contains(&p.as_str()));
        if after_counted && let Some(n) = roman(&w) {
            out.push(n.to_string());
        } else if w.chars().all(|c| c.is_ascii_digit()) {
            let n = w.trim_start_matches('0');
            out.push(if n.is_empty() {
                "0".to_string()
            } else {
                n.to_string()
            });
        } else {
            out.push(w);
        }
    }
    out
}

fn is_number(w: &str) -> bool {
    w.chars().all(|c| c.is_ascii_digit())
}

/// How strongly `question` names the note `title` (0 = not at all). All numbers in the title
/// must appear in the question; at least half of the title's words must.
fn name_score(title_words: &[String], q: &HashSet<String>) -> f32 {
    let meaningful: Vec<&String> = title_words.iter().filter(|w| !is_stopword(w)).collect();
    if meaningful.is_empty() {
        return 0.0;
    }
    if meaningful.iter().any(|w| is_number(w) && !q.contains(*w)) {
        return 0.0;
    }
    let hit: Vec<&&String> = meaningful.iter().filter(|w| q.contains(**w)).collect();
    let has_word = hit.iter().any(|w| !is_number(w) && w.len() >= 3);
    if !has_word {
        return 0.0;
    }
    let coverage = hit.len() as f32 / meaningful.len() as f32;
    if meaningful.len() == 1 && meaningful[0].len() < 4 {
        return 0.0;
    }
    if coverage < 0.5 {
        return 0.0;
    }
    coverage + hit.len() as f32 * 0.01
}

#[derive(Debug, Clone, Serialize)]
pub struct OutlineItem {
    pub heading: String,
    pub first_line: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Outline {
    pub title: String,
    pub path: String,
    pub items: Vec<OutlineItem>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Retrieval {
    /// Notes the question names (paths).
    pub named: Vec<String>,
    /// Outlines for "what is X about" questions.
    pub outlines: Vec<Outline>,
    /// Best passages first.
    pub passages: Vec<ChunkRow>,
    /// Which methods were used (for transparency): "names", "keywords", "meaning", "rerank".
    pub methods: Vec<&'static str>,
}

fn heading_tail(c: &ChunkRow) -> String {
    c.heading_path
        .rsplit(" › ")
        .next()
        .unwrap_or(&c.title)
        .to_string()
}

/// First line of a passage that says something: not a heading, not blank, and not a line that
/// repeats on most passages of the note (page headers and footers).
fn first_line(text: &str, repeated: &HashSet<String>) -> String {
    text.lines()
        .map(|l| l.trim().trim_start_matches(['-', '*', '•', '>', ' ']).trim())
        .find(|l| {
            !l.is_empty()
                && !l.starts_with('#')
                && l.chars().any(char::is_alphabetic)
                && !repeated.contains(&l.to_lowercase())
                && !l.starts_with("![[")
                && !is_boilerplate(l)
        })
        .map(|l| {
            let l = unescape(l);
            if l.chars().count() > 90 {
                format!("{}…", l.chars().take(90).collect::<String>())
            } else {
                l
            }
        })
        .unwrap_or_default()
}

/// Lines Cerebra itself adds to uploaded files' notes; not content.
fn is_boilerplate(l: &str) -> bool {
    l.starts_with("Copied from the file when it was uploaded")
        || l.starts_with("Uploaded file.")
        || l.starts_with("*(The rest of the file's text was cut")
}

/// Merge runs of parts that show the same title ("The Emergence of the Social Web" on
/// pages 14–22) into one line.
fn collapse(items: Vec<OutlineItem>) -> Vec<OutlineItem> {
    let key = |s: &str| {
        s.chars()
            .filter(|c| c.is_alphanumeric())
            .collect::<String>()
            .to_lowercase()
    };
    let num = |h: &str| words(h).into_iter().find(|w| is_number(w));
    let mut out: Vec<(OutlineItem, String)> = Vec::new(); // (item, last heading in the run)
    for it in items {
        if let Some((prev, last)) = out.last_mut() {
            let (a, b) = (key(&prev.first_line), key(&it.first_line));
            if !a.is_empty() && !b.is_empty() && (a.starts_with(&b) || b.starts_with(&a)) {
                if it.first_line.len() > prev.first_line.len() {
                    prev.first_line = it.first_line.clone();
                }
                *last = it.heading.clone();
                continue;
            }
        }
        let h = it.heading.clone();
        out.push((it, h));
    }
    out.into_iter()
        .map(|(mut it, last)| {
            if last != it.heading {
                let first_word = it.heading.split_whitespace().next().unwrap_or("").to_string();
                it.heading = match (num(&it.heading), num(&last)) {
                    (Some(a), Some(b)) if last.starts_with(&first_word) => format!("{first_word}s {a}–{b}"),
                    _ => format!("{} – {}", it.heading, last),
                };
            }
            it
        })
        .collect()
}

/// Undo the Markdown escaping added to text extracted from files (`\[` → `[`).
pub fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\\' && it.peek().is_some_and(|n| n.is_ascii_punctuation()) {
            continue;
        }
        out.push(c);
    }
    out
}

fn outline_of(chunks: &[&ChunkRow]) -> Vec<OutlineItem> {
    // Lines that appear in more than half of the passages are headers/footers.
    let mut counts: HashMap<String, usize> = HashMap::new();
    for c in chunks {
        let uniq: HashSet<String> = c
            .text
            .lines()
            .map(|l| l.trim().to_lowercase())
            .filter(|l| !l.is_empty())
            .collect();
        for l in uniq {
            *counts.entry(l).or_default() += 1;
        }
    }
    let repeated: HashSet<String> = if chunks.len() >= 4 {
        counts
            .into_iter()
            .filter(|(_, n)| *n * 2 > chunks.len())
            .map(|(l, _)| l)
            .collect()
    } else {
        HashSet::new()
    };
    let items: Vec<OutlineItem> = chunks
        .iter()
        .map(|c| OutlineItem {
            heading: heading_tail(c).replace(" (read from the scan)", ""),
            first_line: first_line(&c.text, &repeated),
        })
        // Parts with nothing to show (e.g. the note's own title block) are left out.
        .filter(|i| !i.first_line.is_empty())
        .collect();
    collapse(items)
}

/// Find passages for `question` among the notes of `collection` (or all notes).
pub fn retrieve(
    vault: &Vault,
    store: &Store,
    question: &str,
    collection: Option<&str>,
    limit: usize,
) -> rusqlite::Result<Retrieval> {
    let mut r = Retrieval::default();
    let in_scope = |path: &str| collection.is_none() || collection_of(path).as_deref() == collection;
    let all: Vec<ChunkRow> = store
        .all_chunks()?
        .into_iter()
        .filter(|c| in_scope(&c.path))
        .collect();
    if all.is_empty() {
        return Ok(r);
    }
    let by_id: HashMap<i64, &ChunkRow> = all.iter().map(|c| (c.id, c)).collect();
    let qwords = words(question);
    let qset: HashSet<String> = qwords.iter().cloned().collect();

    // 1. Notes the question names (titles and aliases).
    let mut scored: Vec<(f32, String)> = vault
        .notes
        .iter()
        .filter(|n| in_scope(&n.path))
        .filter_map(|n| {
            let best = std::iter::once(n.title.as_str())
                .chain(n.meta.aliases.iter().map(String::as_str))
                .map(|t| name_score(&words(t), &qset))
                .fold(0.0f32, f32::max);
            (best > 0.0).then(|| (best, n.path.clone()))
        })
        .collect();
    scored.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.1.cmp(&b.1))
    });
    if let Some(top) = scored.first().map(|x| x.0) {
        r.named = scored
            .iter()
            .filter(|x| x.0 >= top - 0.15)
            .take(3)
            .map(|x| x.1.clone())
            .collect();
        r.methods.push("names");
    }
    let named: HashSet<&str> = r.named.iter().map(String::as_str).collect();

    // Overview question about a named note → its outline.
    let overview = qwords.iter().any(|w| OVERVIEW_WORDS.contains(&w.as_str()))
        || qwords.iter().filter(|w| !is_stopword(w)).count() <= 3;
    if overview && !r.named.is_empty() {
        for path in r.named.iter().take(2) {
            let chunks: Vec<&ChunkRow> = all.iter().filter(|c| &c.path == path).collect();
            if let Some(first) = chunks.first() {
                r.outlines.push(Outline {
                    title: first.title.clone(),
                    path: path.clone(),
                    items: outline_of(&chunks),
                });
            }
        }
    }

    // 2. Keyword ranks and meaning ranks, fused (RRF, k = 60).
    let mut fused: HashMap<i64, f32> = HashMap::new();
    let kw: Vec<i64> = store
        .keyword_ranks(question, collection, 60)?
        .into_iter()
        .filter(|id| by_id.contains_key(id))
        .collect();
    if !kw.is_empty() {
        r.methods.push("keywords");
    }
    for (rank, id) in kw.iter().enumerate() {
        *fused.entry(*id).or_default() += 1.0 / (60.0 + rank as f32);
    }
    if let Some(qv) = semantic::embed_query(question) {
        let keyed: Vec<(i64, [u8; 16])> = all
            .iter()
            .map(|c| {
                (
                    c.id,
                    semantic::passage_key(&semantic::passage_text(&c.title, &c.heading_path, &c.text)),
                )
            })
            .collect();
        let keys: Vec<[u8; 16]> = keyed.iter().map(|x| x.1).collect();
        let vecs = semantic::vectors_for(&keys);
        let mut sims: Vec<(f32, i64)> = keyed
            .iter()
            .filter_map(|(id, k)| vecs.get(k).map(|v| (semantic::cosine(&qv, v), *id)))
            .collect();
        if !sims.is_empty() {
            r.methods.push("meaning");
        }
        sims.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        for (rank, (_, id)) in sims.iter().take(60).enumerate() {
            *fused.entry(*id).or_default() += 1.0 / (60.0 + rank as f32);
        }
    }
    // Passages of the notes the question names count extra; with an outline, the opening
    // passages of that note are always candidates.
    for c in &all {
        if named.contains(c.path.as_str()) {
            *fused.entry(c.id).or_default() += 0.6 / 60.0;
        }
    }
    let mut ranked: Vec<(f32, i64)> = fused.into_iter().map(|(id, s)| (s, id)).collect();
    ranked.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.1.cmp(&b.1))
    });
    let mut candidates: Vec<&ChunkRow> = ranked
        .iter()
        .take(30)
        .filter_map(|(_, id)| by_id.get(id).copied())
        .collect();
    // Skip near-empty passages (a heading with nothing under it).
    candidates.retain(|c| c.text.split_whitespace().count() >= 4);
    // "What is X about?": stay inside X.
    if !r.outlines.is_empty() {
        let outlined: HashSet<&str> = r.outlines.iter().map(|o| o.path.as_str()).collect();
        candidates.retain(|c| outlined.contains(c.path.as_str()));
    }

    // 3. Re-rank.
    let texts: Vec<String> = candidates
        .iter()
        .map(|c| semantic::passage_text(&c.title, &c.heading_path, &c.text))
        .collect();
    if let Some(scores) = semantic::rerank(question, &texts) {
        let mut paired: Vec<(f32, &ChunkRow)> = scores.into_iter().zip(candidates.iter().copied()).collect();
        paired.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        candidates = paired.into_iter().map(|x| x.1).collect();
        r.methods.push("rerank");
    }
    r.passages = candidates.into_iter().take(limit).cloned().collect();
    Ok(r)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::LinkIndex;

    fn setup() -> (Vault, Store) {
        let v = Vault::from_notes([
            (
                "Course/UNIT 1 SNA.md",
                "# UNIT 1 SNA\n### Page 1\nHEADER LINE\nIntroduction to the Semantic Web\n### Page 2\nHEADER LINE\nWhat's wrong with the Web? Search is weak.\n### Page 3\nHEADER LINE\nThe emergence of the social web\n### Page 4\nHEADER LINE\nNetwork analysis basics and centrality",
            ),
            (
                "Course/unit4.md",
                "# Unit IV\n### Page 1\nTrust transitivity: A trusts B, B believes x.\n### Page 2\nPrivacy in online social networks",
            ),
            (
                "Course/Unit 2-updated.md",
                "# Unit 2\n### Slide 1\nOntology and RDF triples describe resources.",
            ),
            ("Other/Unit 1 plan.md", "Different collection, unit 1 plan."),
        ]);
        let idx = LinkIndex::build(&v);
        let mut s = Store::open_in_memory().unwrap();
        s.rebuild(&v, &idx).unwrap();
        (v, s)
    }

    #[test]
    fn numbers_match_in_any_form() {
        assert_eq!(words("Unit IV"), vec!["unit", "4"]);
        assert_eq!(words("unit4"), vec!["unit", "4"]);
        assert_eq!(words("UNIT 01 SNA"), vec!["unit", "1", "sna"]);
        assert_eq!(words("I think"), vec!["i", "think"], "a lone I stays a word");
    }

    #[test]
    fn what_is_unit_1_about_gives_its_outline_not_other_units() {
        let (v, s) = setup();
        let r = retrieve(&v, &s, "what is unit 1 about", Some("Course"), 6).unwrap();
        assert_eq!(r.named, vec!["Course/UNIT 1 SNA.md"]);
        let o = &r.outlines[0];
        assert_eq!(o.items.len(), 4);
        assert_eq!(
            o.items[1].first_line, "What's wrong with the Web? Search is weak.",
            "the repeated header is skipped"
        );
        assert!(
            r.passages.iter().all(|p| p.path.ends_with("UNIT 1 SNA.md")),
            "{:?}",
            r.passages.iter().map(|p| &p.path).collect::<Vec<_>>()
        );

        let r4 = retrieve(&v, &s, "summarise unit 4", Some("Course"), 6).unwrap();
        assert_eq!(r4.named, vec!["Course/unit4.md"]);
        let r4b = retrieve(&v, &s, "what does Unit IV cover", Some("Course"), 6).unwrap();
        assert_eq!(r4b.named, vec!["Course/unit4.md"]);
    }

    #[test]
    fn repeated_titles_become_one_line() {
        let items = [
            "Intro",
            "The Social Web",
            "The  social web",
            "TheSocial Web continued",
            "Centrality",
        ]
        .iter()
        .enumerate()
        .map(|(i, t)| OutlineItem {
            heading: format!("Page {}", i + 1),
            first_line: t.to_string(),
        })
        .collect();
        let out = collapse(items);
        let lines: Vec<String> = out
            .iter()
            .map(|i| format!("{}: {}", i.heading, i.first_line))
            .collect();
        assert_eq!(
            lines,
            vec![
                "Page 1: Intro",
                "Pages 2–4: TheSocial Web continued",
                "Page 5: Centrality"
            ]
        );
    }

    #[test]
    fn keyword_questions_ignore_common_words() {
        let (v, s) = setup();
        let r = retrieve(&v, &s, "what is trust transitivity?", Some("Course"), 3).unwrap();
        assert!(r.outlines.is_empty());
        assert!(
            r.passages[0].text.contains("Trust transitivity"),
            "{:?}",
            r.passages
        );
        assert!(r.methods.contains(&"keywords"));
    }

    #[test]
    fn collection_filter_survives_a_crowded_library() {
        let mut notes: Vec<(String, String)> =
            vec![("Biology/Cells.md".into(), "Osmosis in plant cells.".into())];
        for i in 0..61 {
            notes.push((
                format!("Physics/p{i}.md"),
                format!("Osmosis pressure example {i}."),
            ));
        }
        let v = Vault::from_notes(notes.iter().map(|(a, b)| (a.as_str(), b.as_str())));
        let idx = LinkIndex::build(&v);
        let mut s = Store::open_in_memory().unwrap();
        s.rebuild(&v, &idx).unwrap();
        let r = retrieve(&v, &s, "osmosis", Some("Biology"), 6).unwrap();
        assert_eq!(
            r.passages.len(),
            1,
            "{:?}",
            r.passages.iter().map(|p| &p.path).collect::<Vec<_>>()
        );
        assert_eq!(r.passages[0].path, "Biology/Cells.md");
    }
}
