//! Renders a note to sanitised HTML for the UI.
//!
//! Wikilinks and local markdown links are rewritten to `cerebra://` URLs before markdown
//! rendering, using the same resolver as the index, so what is shown always matches
//! what is indexed. Output is sanitised with `ammonia` (no scripts, no raw HTML).
//!
//! URL scheme handled by the UI:
//! - `cerebra://note/<id>[#subpath]`  open a note
//! - `cerebra://embed/<id>`           note embed (UI may transclude)
//! - `cerebra://file/<path>`          attachment (images are rendered inline)
//! - `cerebra://unresolved/<text>`    link to a note that doesn't exist / isn't shared

use std::collections::HashSet;

use comrak::{Options, markdown_to_html};

use crate::model::{LinkKind, LinkRef};
use crate::resolve::Resolver;
use crate::vault::{Vault, is_markdown};

const IMAGE_EXT: &[&str] = &["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "avif"];

pub struct Renderer<'v> {
    vault: &'v Vault,
    resolver: Resolver,
}

impl<'v> Renderer<'v> {
    pub fn new(vault: &'v Vault) -> Renderer<'v> {
        Renderer {
            vault,
            resolver: Resolver::new(&vault.files),
        }
    }

    /// Render the note at `path` (body only; frontmatter is not shown).
    pub fn render(&self, path: &str) -> Option<String> {
        let note = self.vault.note_by_path(path)?;
        let mut md = note.text.clone();
        // Replace from the end so earlier byte offsets stay valid.
        let mut links: Vec<&LinkRef> = note
            .meta
            .links
            .iter()
            .filter(|l| l.kind != LinkKind::Frontmatter)
            .collect();
        links.sort_by_key(|l| std::cmp::Reverse(l.start));
        for l in links {
            let replacement = self.rewrite(l, &note.path);
            md.replace_range(l.start..l.end, &replacement);
        }
        let body = &md[note.meta.body_start.min(md.len())..];
        Some(sanitize(&markdown_to_html(body, &comrak_options())))
    }

    fn rewrite(&self, l: &LinkRef, source: &str) -> String {
        let label = escape_md(&display_text(l));
        match self.resolver.resolve(l, source) {
            Some(dst) if is_markdown(dst) => {
                let id = &self
                    .vault
                    .note_by_path(dst)
                    .map(|n| n.id.clone())
                    .unwrap_or_default();
                if l.embed {
                    format!("[⧉ {label}](cerebra://embed/{id})")
                } else {
                    format!("[{label}](cerebra://note/{id}{})", encode(&l.subpath))
                }
            }
            Some(dst) => {
                let url = format!("cerebra://file/{}", encode(dst));
                if l.embed && is_image(dst) {
                    let alt = escape_md(l.display.as_deref().filter(|d| !is_size(d)).unwrap_or(""));
                    format!("![{alt}]({url})")
                } else {
                    format!("[{label}]({url})")
                }
            }
            None => format!("[{label}](cerebra://unresolved/{})", encode(l.target.trim())),
        }
    }
}

/// What Obsidian-style links show: alias if given, else `Note > Heading`, else `Note`.
pub fn display_text(l: &LinkRef) -> String {
    if let Some(d) = l
        .display
        .as_deref()
        .filter(|d| !d.is_empty() && !(l.embed && is_size(d)))
    {
        return d.to_string();
    }
    let sub = l.subpath.trim_start_matches('#').trim_start_matches('^');
    match (l.target.trim(), sub) {
        ("", s) => s.to_string(),
        (t, "") => t.to_string(),
        (t, s) => format!("{t} > {s}"),
    }
}

fn is_size(s: &str) -> bool {
    let s = s.trim();
    !s.is_empty()
        && s.split('x')
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

fn is_image(path: &str) -> bool {
    path.rsplit('.')
        .next()
        .is_some_and(|e| IMAGE_EXT.contains(&e.to_lowercase().as_str()))
}

fn escape_md(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '\\' | '[' | ']' | '*' | '_' | '`' | '<' | '>' | '|') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Percent-encode everything except unreserved characters and `/` and `#`.
fn encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~/#^".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn comrak_options() -> Options<'static> {
    let mut o = Options::default();
    o.extension.table = true;
    o.extension.strikethrough = true;
    o.extension.tasklist = true;
    o.extension.autolink = true;
    o.extension.footnotes = true;
    o.extension.ofm_callouts = true;
    o.extension.ofm_comments = true;
    o.extension.ofm_block_ids = true;
    o.extension.highlight = true;
    o.extension.header_id_prefix = Some(String::new());
    o.render.r#unsafe = false; // raw HTML in notes is escaped, never executed
    o
}

fn sanitize(html: &str) -> String {
    let mut b = ammonia::Builder::default();
    b.url_schemes(HashSet::from(["cerebra", "http", "https", "mailto"]))
        .add_generic_attributes(["class", "id", "data-callout", "data-callout-fold"])
        .add_tags(["input", "mark", "section"])
        .add_tag_attributes("input", ["type", "checked", "disabled"])
        .link_rel(Some("noopener noreferrer"));
    b.clean(html).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(notes: &[(&str, &str)], path: &str) -> String {
        let v = Vault::from_entries(notes.iter().map(|(p, t)| {
            let content = if is_markdown(p) { Some(t.to_string()) } else { None };
            (p.to_string(), content)
        }));
        Renderer::new(&v).render(path).unwrap()
    }

    #[test]
    fn links_become_cerebra_urls() {
        let html = render(
            &[
                ("A.md", "See [[B#Plan|the plan]] and [[Ghost]] and `[[code]]`"),
                ("B.md", ""),
            ],
            "A.md",
        );
        let id = crate::vault::note_id("B.md");
        assert!(
            html.contains(&format!("href=\"cerebra://note/{id}#Plan\"")),
            "{html}"
        );
        assert!(html.contains(">the plan<"));
        assert!(html.contains("href=\"cerebra://unresolved/Ghost\""));
        assert!(html.contains("<code>[[code]]</code>"), "code untouched: {html}");
    }

    #[test]
    fn image_embeds_and_note_embeds() {
        let html = render(
            &[
                ("A.md", "![[pic.png|300]] ![[B]]"),
                ("img/pic.png", ""),
                ("B.md", ""),
            ],
            "A.md",
        );
        assert!(html.contains("<img src=\"cerebra://file/img/pic.png\""), "{html}");
        assert!(html.contains("cerebra://embed/"));
    }

    #[test]
    fn raw_html_and_scripts_are_neutralised() {
        let html = render(
            &[(
                "A.md",
                "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))",
            )],
            "A.md",
        );
        assert!(!html.contains("<script"), "{html}");
        assert!(!html.contains("onerror"), "{html}");
        assert!(!html.contains("javascript:"), "{html}");
    }

    #[test]
    fn frontmatter_hidden_and_comments_removed() {
        let html = render(
            &[("A.md", "---\nsecret: yes\n---\nHello %%hidden%% world")],
            "A.md",
        );
        assert!(!html.contains("secret"));
        assert!(!html.contains("hidden"), "{html}");
        assert!(html.contains("Hello"));
    }

    #[test]
    fn callouts_render() {
        let html = render(&[("A.md", "> [!warning] Careful\n> Body")], "A.md");
        assert!(html.contains("Careful"), "{html}");
        assert!(html.contains("callout") || html.contains("warning"), "{html}");
    }

    #[test]
    fn display_text_rules() {
        let mut l = crate::parse::parse("[[Note#Head]]").links[0].clone();
        assert_eq!(display_text(&l), "Note > Head");
        l.display = Some("Alias".into());
        assert_eq!(display_text(&l), "Alias");
        let s = crate::parse::parse("[[#Local]]").links[0].clone();
        assert_eq!(display_text(&s), "Local");
    }
}
