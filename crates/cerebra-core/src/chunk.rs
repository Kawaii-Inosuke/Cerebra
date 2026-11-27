//! Splits notes into search/retrieval chunks. See docs/04-DATA-MODEL.md §7:
//! split at H1–H3; sections over 400 tokens are split at paragraphs into ~300-token
//! chunks; every chunk carries its heading path ("Title › H2 › H3").

use serde::Serialize;

use crate::mask::strip_comments;
use crate::vault::Note;

pub const MAX_SECTION_TOKENS: usize = 400;
pub const TARGET_CHUNK_TOKENS: usize = 300;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Chunk {
    pub heading_path: String,
    pub text: String,
    pub tokens: usize,
    /// 0-based line where the chunk starts.
    pub line: usize,
}

/// Rough token estimate (≈ 4 characters per token). Only needs to be approximate.
pub fn estimate_tokens(s: &str) -> usize {
    s.chars().count().div_ceil(4)
}

pub fn chunk_note(note: &Note) -> Vec<Chunk> {
    let clean = strip_block_ids(&strip_comments(&note.text));
    let lines: Vec<&str> = clean.split('\n').collect();
    let body_line = note.text[..note.meta.body_start].matches('\n').count();
    let headings: Vec<_> = note.meta.headings.iter().filter(|h| h.level <= 3).collect();

    // Section boundaries: body start, then each H1–H3 line.
    let mut starts: Vec<(usize, Option<usize>)> = vec![(body_line, None)];
    for (i, h) in headings.iter().enumerate() {
        starts.push((h.line, Some(i)));
    }
    let mut stack: Vec<(u8, String)> = Vec::new();
    let mut out = Vec::new();
    for (si, &(start, heading)) in starts.iter().enumerate() {
        let end = starts.get(si + 1).map(|s| s.0).unwrap_or(lines.len());
        if let Some(hi) = heading {
            let h = headings[hi];
            stack.retain(|(lvl, _)| *lvl < h.level);
            stack.push((h.level, h.text.clone()));
        }
        // An H1 that repeats the note title isn't repeated in the path.
        let path = std::iter::once(note.title.as_str())
            .chain(
                stack
                    .iter()
                    .enumerate()
                    .filter(|(i, (_, t))| !(*i == 0 && t.eq_ignore_ascii_case(&note.title)))
                    .map(|(_, (_, t))| t.as_str()),
            )
            .collect::<Vec<_>>()
            .join(" › ");
        let section_start = if heading.is_some() { start + 1 } else { start };
        let text = lines[section_start.min(end)..end].join("\n");
        split_section(&path, &text, section_start, &mut out);
    }
    out
}

fn split_section(path: &str, text: &str, first_line: usize, out: &mut Vec<Chunk>) {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return;
    }
    if estimate_tokens(trimmed) <= MAX_SECTION_TOKENS {
        out.push(Chunk {
            heading_path: path.into(),
            text: trimmed.into(),
            tokens: estimate_tokens(trimmed),
            line: first_line + leading_blank_lines(text),
        });
        return;
    }
    // Paragraphs, with their starting line.
    let mut paras: Vec<(usize, String)> = Vec::new();
    let mut cur = String::new();
    let mut cur_line = first_line;
    for (i, line) in text.split('\n').enumerate() {
        if line.trim().is_empty() {
            if !cur.trim().is_empty() {
                paras.push((cur_line, std::mem::take(&mut cur)));
            }
            cur.clear();
            cur_line = first_line + i + 1;
        } else {
            if cur.is_empty() {
                cur_line = first_line + i;
            } else {
                cur.push('\n');
            }
            cur.push_str(line);
        }
    }
    if !cur.trim().is_empty() {
        paras.push((cur_line, cur));
    }
    let mut buf = String::new();
    let mut buf_line = first_line;
    let flush = |buf: &mut String, line: usize, out: &mut Vec<Chunk>| {
        let t = buf.trim();
        if !t.is_empty() {
            out.push(Chunk {
                heading_path: path.into(),
                text: t.into(),
                tokens: estimate_tokens(t),
                line,
            });
        }
        buf.clear();
    };
    for (line, p) in paras {
        for piece in split_long(&p) {
            if !buf.is_empty() && estimate_tokens(&buf) + estimate_tokens(&piece) > TARGET_CHUNK_TOKENS {
                flush(&mut buf, buf_line, out);
            }
            if buf.is_empty() {
                buf_line = line;
            } else {
                buf.push_str("\n\n");
            }
            buf.push_str(&piece);
        }
    }
    flush(&mut buf, buf_line, out);
}

/// Split a single over-long paragraph at whitespace into ≤ TARGET_CHUNK_TOKENS pieces.
fn split_long(p: &str) -> Vec<String> {
    if estimate_tokens(p) <= MAX_SECTION_TOKENS {
        return vec![p.to_string()];
    }
    let max_chars = TARGET_CHUNK_TOKENS * 4;
    let mut out = Vec::new();
    let mut cur = String::new();
    for word in p.split_inclusive(char::is_whitespace) {
        if cur.chars().count() + word.chars().count() > max_chars && !cur.is_empty() {
            out.push(std::mem::take(&mut cur).trim().to_string());
        }
        cur.push_str(word);
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    out
}

/// Remove `^block-id` markers at line ends (they are anchors, not content).
fn strip_block_ids(text: &str) -> String {
    static BLOCK: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"(?m)(^|[ \t])\^[A-Za-z0-9\-]+[ \t]*$").unwrap());
    BLOCK.replace_all(text, "$1").into_owned()
}

fn leading_blank_lines(text: &str) -> usize {
    text.split('\n').take_while(|l| l.trim().is_empty()).count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::Vault;

    fn chunks(text: &str) -> Vec<Chunk> {
        let v = Vault::from_notes([("Plan.md", text)]);
        chunk_note(&v.notes[0])
    }

    #[test]
    fn splits_at_headings_with_paths() {
        let c = chunks("---\ntags: [x]\n---\nIntro text\n# Top\nA\n## Sub\nB\n#### Deep\nC\n## Other\nD");
        let paths: Vec<_> = c.iter().map(|c| c.heading_path.as_str()).collect();
        assert_eq!(
            paths,
            vec!["Plan", "Plan › Top", "Plan › Top › Sub", "Plan › Top › Other"]
        );
        assert_eq!(c[0].text, "Intro text");
        assert_eq!(c[0].line, 3);
        assert_eq!(c[2].text, "B\n#### Deep\nC", "H4 stays inside its H2 section");
    }

    #[test]
    fn title_h1_not_repeated_and_block_ids_stripped() {
        let c = chunks("# Plan\nIntro ^blk\n## Timeline\nDate");
        assert_eq!(c[0].heading_path, "Plan");
        assert_eq!(c[0].text, "Intro");
        assert_eq!(c[1].heading_path, "Plan › Timeline");
    }

    #[test]
    fn comments_are_not_indexed() {
        let c = chunks("Visible %% secret %% text");
        assert!(!c[0].text.contains("secret"));
    }

    #[test]
    fn long_sections_split_into_target_sized_chunks() {
        let para = "word ".repeat(200); // ~250 tokens
        let text = format!("# H\n{para}\n\n{para}\n\n{para}");
        let c = chunks(&text);
        assert!(c.len() >= 3, "got {}", c.len());
        assert!(c.iter().all(|c| c.tokens <= MAX_SECTION_TOKENS));
        assert!(c.iter().all(|c| c.heading_path == "Plan › H"));
    }

    #[test]
    fn giant_paragraph_is_split() {
        let text = "x ".repeat(3000);
        let c = chunks(&text);
        assert!(c.len() > 1);
        assert!(c.iter().all(|c| c.tokens <= MAX_SECTION_TOKENS));
    }

    #[test]
    fn empty_note_has_no_chunks() {
        assert!(chunks("").is_empty());
        assert!(chunks("---\na: 1\n---\n").is_empty());
    }
}
