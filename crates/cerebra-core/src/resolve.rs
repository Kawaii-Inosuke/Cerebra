//! Link resolution: link text → vault file. See docs/05-LINK-ENGINE.md §3.
//!
//! Rule (deterministic, to be confirmed against Obsidian with fixtures F2/F3/F7/F8):
//! 1. Empty target (`[[#Heading]]`) → the source note itself.
//! 2. Markdown links: try the path relative to the source note's folder first.
//! 3. Target containing `/`: exact vault path (case-insensitive), else path-suffix match.
//! 4. Otherwise: file-name match (case-insensitive), `.md` implied for notes.
//! 5. Ties: same folder as source → fewest path segments → shortest path → alphabetical.
//! 6. Aliases are NOT used for resolution.

use std::collections::HashMap;

use crate::model::{LinkKind, LinkRef};

pub struct Resolver {
    paths: Vec<String>,
    by_path: HashMap<String, usize>,
    by_name: HashMap<String, Vec<usize>>,
}

impl Resolver {
    pub fn new(paths: &[String]) -> Resolver {
        let mut by_path = HashMap::new();
        let mut by_name: HashMap<String, Vec<usize>> = HashMap::new();
        for (i, p) in paths.iter().enumerate() {
            by_path.insert(p.to_lowercase(), i);
            let name = p.rsplit('/').next().unwrap_or(p).to_lowercase();
            by_name.entry(name).or_default().push(i);
        }
        Resolver {
            paths: paths.to_vec(),
            by_path,
            by_name,
        }
    }

    /// Resolve a link found in `source` (vault-relative path). Returns the target path.
    pub fn resolve(&self, link: &LinkRef, source: &str) -> Option<&str> {
        let t = link.target.trim();
        if t.is_empty() {
            return self
                .by_path
                .get(&source.to_lowercase())
                .map(|&i| self.paths[i].as_str());
        }
        if link.kind == LinkKind::Markdown
            && let Some(rel) = join_relative(parent(source), t)
        {
            for cand in candidates(&rel) {
                if let Some(&i) = self.by_path.get(&cand.to_lowercase()) {
                    return Some(&self.paths[i]);
                }
            }
        }
        self.resolve_text(t, source)
    }

    /// Resolve plain link text like `Folder/Note` or `Note` from `source`.
    pub fn resolve_text(&self, target: &str, source: &str) -> Option<&str> {
        let t = target.trim().trim_start_matches('/');
        for cand in candidates(t) {
            let lc = cand.to_lowercase();
            let matches: Vec<usize> = if lc.contains('/') {
                if let Some(&i) = self.by_path.get(&lc) {
                    vec![i]
                } else {
                    let suffix = format!("/{lc}");
                    self.paths
                        .iter()
                        .enumerate()
                        .filter(|(_, p)| p.to_lowercase().ends_with(&suffix))
                        .map(|(i, _)| i)
                        .collect()
                }
            } else {
                self.by_name.get(&lc).cloned().unwrap_or_default()
            };
            if let Some(best) = self.best(&matches, source) {
                return Some(&self.paths[best]);
            }
        }
        None
    }

    fn best(&self, matches: &[usize], source: &str) -> Option<usize> {
        let src_dir = parent(source);
        matches.iter().copied().min_by(|&a, &b| {
            let (pa, pb) = (&self.paths[a], &self.paths[b]);
            let same = |p: &str| if parent(p) == src_dir { 0 } else { 1 };
            (same(pa), pa.matches('/').count(), pa.len(), pa).cmp(&(
                same(pb),
                pb.matches('/').count(),
                pb.len(),
                pb,
            ))
        })
    }
}

/// `Note` → [`Note.md`, `Note`]; `Note.md` → [`Note.md`]; `img.png` → [`img.png.md`, `img.png`].
fn candidates(t: &str) -> Vec<String> {
    if t.to_lowercase().ends_with(".md") {
        vec![t.to_string()]
    } else {
        vec![format!("{t}.md"), t.to_string()]
    }
}

fn parent(path: &str) -> &str {
    path.rfind('/').map(|i| &path[..i]).unwrap_or("")
}

/// Join `rel` onto `dir`, normalising `.` and `..`. `None` if it escapes the vault.
fn join_relative(dir: &str, rel: &str) -> Option<String> {
    let mut parts: Vec<&str> = if rel.starts_with('/') {
        Vec::new()
    } else {
        dir.split('/').filter(|s| !s.is_empty()).collect()
    };
    for seg in rel.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            s => parts.push(s),
        }
    }
    Some(parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(paths: &[&str]) -> Resolver {
        Resolver::new(&paths.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }

    fn wiki(t: &str) -> LinkRef {
        LinkRef {
            target: t.into(),
            subpath: String::new(),
            display: None,
            embed: false,
            kind: LinkKind::Wiki,
            line: 0,
            start: 0,
            end: 0,
        }
    }

    #[test]
    fn by_name_case_insensitive() {
        let res = r(&["A/Note.md", "Other.md"]);
        assert_eq!(res.resolve(&wiki("note"), "Other.md"), Some("A/Note.md"));
        assert_eq!(res.resolve(&wiki("Missing"), "Other.md"), None);
    }

    #[test]
    fn duplicates_prefer_same_folder_then_shallow() {
        let res = r(&["X/Dup.md", "Y/Z/Dup.md", "Y/Z/Src.md", "Top.md"]);
        assert_eq!(res.resolve(&wiki("Dup"), "Y/Z/Src.md"), Some("Y/Z/Dup.md"));
        assert_eq!(res.resolve(&wiki("Dup"), "Top.md"), Some("X/Dup.md"));
    }

    #[test]
    fn paths_exact_and_suffix() {
        let res = r(&["Courses/Biology/Plan.md", "Courses/Physics/Plan.md"]);
        assert_eq!(
            res.resolve(&wiki("Physics/Plan"), "x.md"),
            Some("Courses/Physics/Plan.md")
        );
        assert_eq!(
            res.resolve(&wiki("courses/biology/plan.md"), "x.md"),
            Some("Courses/Biology/Plan.md")
        );
    }

    #[test]
    fn attachments_and_self() {
        let res = r(&["img/pic.png", "Self.md"]);
        assert_eq!(res.resolve(&wiki("pic.png"), "Self.md"), Some("img/pic.png"));
        assert_eq!(res.resolve(&wiki(""), "Self.md"), Some("Self.md"));
    }

    #[test]
    fn markdown_relative_first() {
        let res = r(&["a/b/Note.md", "Note.md", "a/c.md"]);
        let mut l = wiki("../Note.md");
        l.kind = LinkKind::Markdown;
        // a/Note.md doesn't exist, so a relative path that points nowhere stays unresolved.
        assert_eq!(res.resolve(&l, "a/b/x.md"), None);
        let mut l2 = wiki("Note.md");
        l2.kind = LinkKind::Markdown;
        assert_eq!(res.resolve(&l2, "a/b/x.md"), Some("a/b/Note.md"));
        let mut l3 = wiki("../c.md");
        l3.kind = LinkKind::Markdown;
        assert_eq!(res.resolve(&l3, "a/b/x.md"), Some("a/c.md"));
    }

    #[test]
    fn join_relative_cases() {
        assert_eq!(join_relative("a/b", "../c.md").as_deref(), Some("a/c.md"));
        assert_eq!(join_relative("", "../x.md"), None);
        assert_eq!(join_relative("a", "/root.md").as_deref(), Some("root.md"));
    }
}
