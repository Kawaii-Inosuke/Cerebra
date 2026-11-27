//! Extracts Obsidian-style metadata from one markdown file.
//!
//! Behaviour follows Obsidian's public help docs (Internal links, Embeds, Aliases, Tags,
//! Properties, Comments). Anything uncertain is pinned down by black-box fixtures in
//! `fixtures/vaults/compat`, not by guessing.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::mask::mask;
use crate::model::{BlockId, Heading, LinkKind, LinkRef, NoteMeta};

static WIKILINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(!?)\[\[([^\[\]\n]+?)\]\]").unwrap());
// [text](target "optional title") — target without spaces, or <target with spaces>.
static MDLINK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(!?)\[([^\]\n]*)\]\((?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"\n]*")?\)"#).unwrap()
});
static HEADING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*$").unwrap());
// A tag starts after start-of-text or whitespace, and must contain a non-digit.
static TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|[\s(,])#([\p{L}\p{N}_/\-]+)").unwrap());
static BLOCK_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)(?:^|[ \t])\^([A-Za-z0-9\-]+)[ \t]*$").unwrap());
static URL_SCHEME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z][A-Za-z0-9+.\-]*:").unwrap());

/// Parse a whole markdown file.
pub fn parse(text: &str) -> NoteMeta {
    let mut meta = NoteMeta::default();
    let (fm_raw, body_start) = split_frontmatter(text);
    meta.body_start = body_start;

    if let Some(raw) = fm_raw {
        match serde_yaml_ng::from_str::<Value>(raw) {
            Ok(v) => meta.frontmatter = v,
            Err(e) => meta.frontmatter_error = Some(e.to_string()),
        }
    }
    meta.aliases = string_list(&meta.frontmatter, &["aliases", "alias"], false);
    let mut tags = string_list(&meta.frontmatter, &["tags", "tag"], true);

    // Wikilinks inside frontmatter property values.
    if let Some(raw) = fm_raw {
        let fm_offset = text.find(raw).unwrap_or(0);
        for v in string_values(&meta.frontmatter) {
            for cap in WIKILINK.captures_iter(&v) {
                let mut l = wikilink_from_inner(&cap[2], !cap[1].is_empty());
                l.kind = LinkKind::Frontmatter;
                l.line = line_of(text, fm_offset);
                l.start = fm_offset;
                l.end = fm_offset;
                meta.links.push(l);
            }
        }
    }

    let masked_full = mask(text);
    let body = &masked_full[body_start..];

    for cap in WIKILINK.captures_iter(body) {
        let m = cap.get(0).unwrap();
        let mut l = wikilink_from_inner(&cap[2], !cap[1].is_empty());
        l.start = body_start + m.start();
        l.end = body_start + m.end();
        l.line = line_of(text, l.start);
        meta.links.push(l);
    }

    for cap in MDLINK.captures_iter(body) {
        let m = cap.get(0).unwrap();
        // Skip matches that overlap a wikilink, e.g. `[[a]](b)`.
        let start = body_start + m.start();
        if meta
            .links
            .iter()
            .any(|l| l.kind == LinkKind::Wiki && start < l.end && l.start < body_start + m.end())
        {
            continue;
        }
        let raw = cap.get(3).or(cap.get(4)).unwrap().as_str();
        if URL_SCHEME.is_match(raw) {
            continue; // http:, mailto:, obsidian: … are external
        }
        let decoded = percent_decode(raw);
        let (target, subpath) = split_subpath(&decoded);
        meta.links.push(LinkRef {
            target: target.to_string(),
            subpath: subpath.to_string(),
            display: Some(cap[2].to_string()).filter(|s| !s.is_empty()),
            embed: !cap[1].is_empty(),
            kind: LinkKind::Markdown,
            line: line_of(text, start),
            start,
            end: body_start + m.end(),
        });
    }
    meta.links.sort_by_key(|l| (l.start, l.end));

    for cap in HEADING.captures_iter(body) {
        let m = cap.get(0).unwrap();
        let raw = cap[2].trim_end_matches('#').trim_end();
        meta.headings.push(Heading {
            level: cap[1].len() as u8,
            text: raw.to_string(),
            line: line_of(text, body_start + m.start()),
        });
    }

    for cap in TAG.captures_iter(body) {
        let t = cap[1].trim_end_matches('/').to_string();
        if !t.is_empty() && !t.chars().all(|c| c.is_ascii_digit()) {
            tags.push(t);
        }
    }
    meta.tags = dedupe_ci(tags);

    for cap in BLOCK_ID.captures_iter(body) {
        let m = cap.get(1).unwrap();
        meta.blocks.push(BlockId {
            id: m.as_str().to_string(),
            line: line_of(text, body_start + m.start()),
        });
    }
    meta
}

/// Split `[[inner]]` into target / subpath / display. `\|` (escaped pipe used inside
/// tables) is treated as the separator too.
fn wikilink_from_inner(inner: &str, embed: bool) -> LinkRef {
    let normalized = inner.replace("\\|", "|");
    let (left, display) = match normalized.split_once('|') {
        Some((l, d)) => (l.to_string(), Some(d.trim().to_string())),
        None => (normalized.clone(), None),
    };
    let (target, subpath) = split_subpath(left.trim());
    LinkRef {
        target: target.trim().to_string(),
        subpath: subpath.trim().to_string(),
        display,
        embed,
        kind: LinkKind::Wiki,
        line: 0,
        start: 0,
        end: 0,
    }
}

fn split_subpath(s: &str) -> (&str, &str) {
    match s.find('#') {
        Some(i) => (&s[..i], &s[i..]),
        None => (s, ""),
    }
}

/// Returns (frontmatter text, offset where the body starts).
fn split_frontmatter(text: &str) -> (Option<&str>, usize) {
    let first_line_end = match text.find('\n') {
        Some(i) => i,
        None => return (None, 0),
    };
    if text[..first_line_end].trim_end() != "---" {
        return (None, 0);
    }
    let mut offset = first_line_end + 1;
    for line in text[offset..].split_inclusive('\n') {
        let t = line.trim_end();
        if t == "---" || t == "..." {
            let fm = &text[first_line_end + 1..offset];
            return (Some(fm), offset + line.len());
        }
        offset += line.len();
    }
    (None, 0) // unclosed: treat the whole file as body
}

fn line_of(text: &str, byte: usize) -> usize {
    text.as_bytes()[..byte.min(text.len())]
        .iter()
        .filter(|&&b| b == b'\n')
        .count()
}

/// Reads a property that may be a string or a list. For tags, strings are split on
/// commas/spaces and a leading `#` is removed.
fn string_list(fm: &Value, keys: &[&str], is_tags: bool) -> Vec<String> {
    let mut out = Vec::new();
    for key in keys {
        let Some(v) = fm.get(*key) else { continue };
        let mut push = |s: &str| {
            if is_tags {
                for part in s.split([',', ' ']) {
                    let p = part.trim().trim_start_matches('#');
                    if !p.is_empty() {
                        out.push(p.to_string());
                    }
                }
            } else if !s.trim().is_empty() {
                out.push(s.trim().to_string());
            }
        };
        match v {
            Value::String(s) => push(s),
            Value::Array(items) => {
                for i in items {
                    match i {
                        Value::String(s) => push(s),
                        Value::Number(n) => push(&n.to_string()),
                        _ => {}
                    }
                }
            }
            Value::Number(n) => push(&n.to_string()),
            _ => {}
        }
    }
    out
}

/// All string values anywhere in the frontmatter (for links in properties).
fn string_values(v: &Value) -> Vec<String> {
    let mut out = Vec::new();
    fn walk(v: &Value, out: &mut Vec<String>) {
        match v {
            Value::String(s) => out.push(s.clone()),
            Value::Array(a) => a.iter().for_each(|x| walk(x, out)),
            Value::Object(o) => o.values().for_each(|x| walk(x, out)),
            _ => {}
        }
    }
    walk(v, &mut out);
    out
}

fn dedupe_ci(items: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    items
        .into_iter()
        .filter(|t| seen.insert(t.to_lowercase()))
        .collect()
}

/// Minimal `%XX` decoding for markdown link targets (invalid sequences are kept).
pub fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = |c: u8| (c as char).to_digit(16);
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn targets(m: &NoteMeta) -> Vec<(String, String, Option<String>, bool)> {
        m.links
            .iter()
            .map(|l| (l.target.clone(), l.subpath.clone(), l.display.clone(), l.embed))
            .collect()
    }

    #[test]
    fn wikilink_forms() {
        let m = parse("[[A]] [[B|Bee]] [[C#Head]] [[D#^blk|x]] [[#Local]] ![[img.png|300]]");
        assert_eq!(
            targets(&m),
            vec![
                ("A".into(), "".into(), None, false),
                ("B".into(), "".into(), Some("Bee".into()), false),
                ("C".into(), "#Head".into(), None, false),
                ("D".into(), "#^blk".into(), Some("x".into()), false),
                ("".into(), "#Local".into(), None, false),
                ("img.png".into(), "".into(), Some("300".into()), true),
            ]
        );
    }

    #[test]
    fn links_in_code_and_comments_ignored() {
        let m = parse("`[[no1]]`\n```\n[[no2]]\n```\n%% [[no3]] %%\n[[yes]]");
        assert_eq!(m.links.len(), 1);
        assert_eq!(m.links[0].target, "yes");
        assert_eq!(m.links[0].line, 5);
    }

    #[test]
    fn table_escaped_pipe() {
        let m = parse("| a | [[Note\\|Shown]] |");
        assert_eq!(m.links[0].target, "Note");
        assert_eq!(m.links[0].display.as_deref(), Some("Shown"));
    }

    #[test]
    fn markdown_links_local_only() {
        let m = parse("[x](Other%20Note.md) [y](https://e.com) [z](<With Space.md#H>) ![i](pic.png)");
        assert_eq!(
            targets(&m),
            vec![
                ("Other Note.md".into(), "".into(), Some("x".into()), false),
                ("With Space.md".into(), "#H".into(), Some("z".into()), false),
                ("pic.png".into(), "".into(), Some("i".into()), true),
            ]
        );
    }

    #[test]
    fn frontmatter_aliases_tags_links() {
        let t = "---\naliases: [Cell Basics, Cells]\ntags: [launch, '#q3']\nowner: \"[[Alex]]\"\n---\n# Title\nBody #inline/tag and #123 and a#b";
        let m = parse(t);
        assert_eq!(m.aliases, vec!["Cell Basics", "Cells"]);
        assert_eq!(m.tags, vec!["launch", "q3", "inline/tag"]);
        assert_eq!(m.links[0].target, "Alex");
        assert_eq!(m.links[0].kind, LinkKind::Frontmatter);
        assert_eq!(
            m.headings,
            vec![Heading {
                level: 1,
                text: "Title".into(),
                line: 5
            }]
        );
    }

    #[test]
    fn string_tags_and_singular_keys() {
        let m = parse("---\ntag: one, two three\nalias: Solo\n---\n");
        assert_eq!(m.tags, vec!["one", "two", "three"]);
        assert_eq!(m.aliases, vec!["Solo"]);
    }

    #[test]
    fn invalid_frontmatter_is_reported_not_fatal() {
        let m = parse("---\n: : bad\n  - x\n---\n[[A]]");
        assert!(m.frontmatter_error.is_some());
        assert_eq!(m.links[0].target, "A");
    }

    #[test]
    fn headings_and_blocks() {
        let m = parse("## Two ##\nnot#heading\n####### seven\nPara text ^abc-1\n^solo\n");
        assert_eq!(
            m.headings,
            vec![Heading {
                level: 2,
                text: "Two".into(),
                line: 0
            }]
        );
        assert_eq!(
            m.blocks,
            vec![
                BlockId {
                    id: "abc-1".into(),
                    line: 3
                },
                BlockId {
                    id: "solo".into(),
                    line: 4
                }
            ]
        );
    }

    #[test]
    fn heading_hash_is_not_a_tag() {
        let m = parse("# Heading\n#real");
        assert_eq!(m.tags, vec!["real"]);
    }

    #[test]
    fn percent_decode_works() {
        assert_eq!(percent_decode("a%20b%2Fc"), "a b/c");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }
}
