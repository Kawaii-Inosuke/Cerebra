//! "Copy context": turn a question into a short, relevant context pack (≤ ~2,500 tokens)
//! that can be pasted into any AI chat (docs/07-CONNECTOR-MCP.md).

use serde::Serialize;

use crate::chunk::estimate_tokens;
use crate::collection::collection_of;
use crate::graph::LinkIndex;
use crate::mask::strip_comments;
use crate::retrieve::{retrieve, unescape};
use crate::store::Store;
use crate::vault::Vault;

pub const DEFAULT_BUDGET: usize = 2500;

#[derive(Debug, Clone, Serialize)]
pub struct ContextPack {
    pub text: String,
    pub tokens: usize,
    pub sources: Vec<String>,
}

/// Build the pack within `budget` tokens: question, collection card, outline of a note the
/// question names (for "what is X about"), the best passages (`retrieve.rs`: names +
/// keywords + meaning + re-ranking), then one-line summaries of linked notes if room is left.
pub fn build_context(
    vault: &Vault,
    index: &LinkIndex,
    store: &Store,
    question: &str,
    collection: Option<&str>,
    budget: usize,
) -> rusqlite::Result<ContextPack> {
    let mut sources: Vec<String> = Vec::new();
    let head = format!(
        "Answer only from the notes below, and say so if they don't cover the question.\nQuestion: {}",
        question.trim()
    );
    let mut parts: Vec<String> = vec![head];
    let used = |parts: &Vec<String>| estimate_tokens(&parts.join("\n\n")) + 30;

    if let Some(c) = collection {
        let hub = vault
            .notes
            .iter()
            .filter(|n| collection_of(&n.path).as_deref() == Some(c))
            .min_by_key(|n| {
                (
                    !n.title.to_lowercase().contains("overview"),
                    n.path.matches('/').count(),
                    n.path.clone(),
                )
            });
        if let Some(h) = hub {
            parts.push(format!(
                "## Collection: {c}\n{}",
                first_words(&h.text, h.meta.body_start, 80)
            ));
            sources.push(h.title.clone());
        }
    }

    let found = retrieve(vault, store, question, collection, 12)?;

    // Outline (at most ~40% of the budget).
    for o in &found.outlines {
        let mut lines = vec![format!(
            "## Outline of \"{}\" ({} parts, in order)",
            o.title,
            o.items.len()
        )];
        let cap = budget * 2 / 5;
        for it in &o.items {
            let line = if it.first_line.is_empty() {
                format!("- {}", it.heading)
            } else {
                format!("- {}: {}", it.heading, it.first_line)
            };
            lines.push(line);
            if estimate_tokens(&lines.join("\n")) > cap {
                lines.pop();
                lines.push(format!("- … {} more parts", o.items.len() + 1 - lines.len()));
                break;
            }
        }
        parts.push(lines.join("\n"));
        if !sources.contains(&o.title) {
            sources.push(o.title.clone());
        }
    }

    // Passages, best first, while they fit (each cut to ~350 tokens).
    let mut passages = Vec::new();
    let mut used_notes: Vec<String> = Vec::new();
    for p in &found.passages {
        let body: String = unescape(p.text.trim()).chars().take(1400).collect();
        let block = format!(
            "### {}\n{}",
            if p.heading_path.is_empty() {
                &p.title
            } else {
                &p.heading_path
            },
            body
        );
        let mut trial = parts.clone();
        trial.push(format!(
            "## Relevant passages\n{}",
            passages
                .iter()
                .chain(std::iter::once(&block))
                .cloned()
                .collect::<Vec<_>>()
                .join("\n\n")
        ));
        if used(&trial) > budget {
            continue;
        }
        passages.push(block);
        if !sources.contains(&p.title) {
            sources.push(p.title.clone());
        }
        if !used_notes.contains(&p.path) {
            used_notes.push(p.path.clone());
        }
    }
    if !passages.is_empty() {
        parts.push(format!("## Relevant passages\n{}", passages.join("\n\n")));
    }

    // Linked notes, one line each, if there's room.
    let mut related: Vec<String> = Vec::new();
    for p in &used_notes {
        for n in index.neighborhood(p, 1) {
            if used_notes.contains(&n) || related.iter().any(|r| r.contains(&n)) {
                continue;
            }
            if let Some(note) = vault.note_by_path(&n) {
                if collection.is_some() && collection_of(&note.path).as_deref() != collection {
                    continue;
                }
                let line = format!(
                    "- {}: {}",
                    note.title,
                    first_words(&note.text, note.meta.body_start, 25)
                );
                let mut trial = parts.clone();
                trial.push(format!(
                    "## Linked notes\n{}",
                    related
                        .iter()
                        .chain(std::iter::once(&line))
                        .cloned()
                        .collect::<Vec<_>>()
                        .join("\n")
                ));
                if used(&trial) <= budget && related.len() < 6 {
                    related.push(line);
                }
            }
        }
    }
    if !related.is_empty() {
        parts.push(format!("## Linked notes\n{}", related.join("\n")));
    }
    if found.outlines.is_empty() && passages.is_empty() {
        parts.push("No notes matched this question.".into());
    }
    parts.push(format!("Sources: {}", sources.join(", ")));

    let mut text = parts.join("\n\n");
    // Last resort for very small budgets: drop lines from the middle.
    while estimate_tokens(&text) > budget {
        let mut lines: Vec<&str> = text.lines().collect();
        if lines.len() < 4 {
            break;
        }
        let sources_line = lines.pop().unwrap_or("");
        lines.pop();
        text = format!("{}\n{}", lines.join("\n"), sources_line);
    }
    Ok(ContextPack {
        tokens: estimate_tokens(&text),
        text,
        sources,
    })
}

/// First `n` words of a note body, without frontmatter, comments, headings or link brackets.
fn first_words(text: &str, body_start: usize, n: usize) -> String {
    let body = strip_comments(&text[body_start.min(text.len())..]);
    let cleaned: Vec<String> = body
        .lines()
        .filter(|l| !l.trim_start().starts_with('#') && !l.trim_start().starts_with("> [!"))
        .flat_map(|l| l.split_whitespace())
        .map(|w| w.replace("[[", "").replace("]]", "").replace("**", ""))
        .filter(|w| !w.is_empty())
        .take(n)
        .collect();
    cleaned.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pack(v: &Vault, q: &str, collection: Option<&str>, budget: usize) -> ContextPack {
        let idx = LinkIndex::build(v);
        let mut s = Store::open_in_memory().unwrap();
        s.rebuild(v, &idx).unwrap();
        build_context(v, &idx, &s, q, collection, budget).unwrap()
    }

    #[test]
    fn builds_small_cited_pack() {
        let v = Vault::from_notes([
            (
                "Biology/Biology Overview.md",
                "# Biology Overview\nCells are the unit of life. See [[Exam Plan]].",
            ),
            (
                "Biology/Exam Plan.md",
                "# Exam Plan\n## Timeline\nExam date is 12 March.\n## Topics\nCell membranes. [[Membranes]]",
            ),
            ("Biology/Membranes.md", "Phospholipids form the bilayer."),
            ("Physics/Other.md", "Exam date for Physics is June."),
        ]);
        let p = pack(&v, "When is the exam date?", Some("Biology"), DEFAULT_BUDGET);
        assert!(p.text.starts_with("Answer only from the notes below, and say so if they don't cover the question.\nQuestion: When is the exam date?"), "{}", p.text);
        assert!(p.text.contains("Exam date is 12 March"), "{}", p.text);
        assert!(!p.text.contains("June"), "other collection excluded: {}", p.text);
        assert!(p.text.contains("## Collection: Biology"), "{}", p.text);
        assert!(
            p.text.contains("Phospholipids"),
            "1-hop related summary: {}",
            p.text
        );
        assert!(p.sources.contains(&"Exam Plan".to_string()));
        assert!(p.tokens <= DEFAULT_BUDGET);
        let tiny = pack(&v, "exam", Some("Biology"), 60);
        assert!(tiny.tokens <= 80, "{}", tiny.tokens);
        assert!(
            tiny.text
                .trim_end()
                .ends_with(&format!("Sources: {}", tiny.sources.join(", ")))
        );
    }

    #[test]
    fn root_notes_have_no_collection_and_are_excluded_by_filter() {
        let v = Vault::from_notes([
            ("Biology/Transport.md", "Osmosis moves water across a membrane."),
            ("Quick.md", "Osmosis reminder for the exam."),
        ]);
        let filtered = pack(&v, "osmosis", Some("Biology"), DEFAULT_BUDGET);
        assert!(filtered.text.contains("membrane"), "{}", filtered.text);
        assert!(!filtered.text.contains("exam"), "{}", filtered.text);
        let all = pack(&v, "osmosis", None, DEFAULT_BUDGET);
        assert!(
            all.text.contains("membrane") && all.text.contains("exam"),
            "{}",
            all.text
        );
    }
}
