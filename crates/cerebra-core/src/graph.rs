//! The link graph: every link occurrence resolved, plus the views built on it
//! (backlinks, outgoing, unresolved, orphans, dead ends, graph JSON).

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use crate::model::{LinkKind, LinkRef};
use crate::resolve::Resolver;
use crate::vault::{Vault, is_markdown};

/// One link occurrence after resolution.
#[derive(Debug, Clone, Serialize)]
pub struct Edge {
    pub src: String,
    /// Resolved target path, or `None` if unresolved.
    pub dst: Option<String>,
    pub target_text: String,
    pub subpath: String,
    pub display: Option<String>,
    pub embed: bool,
    pub kind: LinkKind,
    pub line: usize,
}

#[derive(Debug, Default)]
pub struct LinkIndex {
    pub edges: Vec<Edge>,
    /// `resolved[src][dst] = count` (self-links excluded).
    pub resolved: BTreeMap<String, BTreeMap<String, usize>>,
    /// `unresolved[src][text] = count`.
    pub unresolved: BTreeMap<String, BTreeMap<String, usize>>,
}

impl LinkIndex {
    pub fn build(vault: &Vault) -> LinkIndex {
        let resolver = Resolver::new(&vault.files);
        let mut idx = LinkIndex::default();
        for note in &vault.notes {
            for l in &note.meta.links {
                let dst = resolver.resolve(l, &note.path).map(str::to_string);
                idx.push(&note.path, l, dst);
            }
        }
        idx
    }

    fn push(&mut self, src: &str, l: &LinkRef, dst: Option<String>) {
        match &dst {
            Some(d) if d != src => {
                *self
                    .resolved
                    .entry(src.into())
                    .or_default()
                    .entry(d.clone())
                    .or_default() += 1;
            }
            Some(_) => {}
            None => {
                *self
                    .unresolved
                    .entry(src.into())
                    .or_default()
                    .entry(l.target.trim().to_string())
                    .or_default() += 1;
            }
        }
        self.edges.push(Edge {
            src: src.into(),
            dst,
            target_text: l.target.clone(),
            subpath: l.subpath.clone(),
            display: l.display.clone(),
            embed: l.embed,
            kind: l.kind,
            line: l.line,
        });
    }

    pub fn outgoing<'a>(&'a self, path: &'a str) -> impl Iterator<Item = &'a Edge> + 'a {
        self.edges.iter().filter(move |e| e.src == path)
    }

    /// Links pointing at `path` from other notes, grouped by source (sorted).
    pub fn backlinks(&self, path: &str) -> BTreeMap<&str, Vec<&Edge>> {
        let mut out: BTreeMap<&str, Vec<&Edge>> = BTreeMap::new();
        for e in &self.edges {
            if e.dst.as_deref() == Some(path) && e.src != path {
                out.entry(e.src.as_str()).or_default().push(e);
            }
        }
        out
    }

    /// Markdown notes with no resolved links in or out (self-links don't count).
    pub fn orphans<'a>(&self, vault: &'a Vault) -> Vec<&'a str> {
        let linked: BTreeSet<&str> = self
            .resolved
            .iter()
            .flat_map(|(s, ds)| std::iter::once(s.as_str()).chain(ds.keys().map(String::as_str)))
            .collect();
        vault
            .notes
            .iter()
            .map(|n| n.path.as_str())
            .filter(|p| !linked.contains(p))
            .collect()
    }

    /// Markdown notes with no outgoing links of any kind (resolved or not).
    pub fn dead_ends<'a>(&self, vault: &'a Vault) -> Vec<&'a str> {
        vault
            .notes
            .iter()
            .map(|n| n.path.as_str())
            .filter(|p| {
                !self
                    .edges
                    .iter()
                    .any(|e| e.src == *p && e.dst.as_deref() != Some(*p))
            })
            .collect()
    }

    pub fn graph(&self, vault: &Vault, opts: GraphOptions) -> GraphData {
        let mut nodes: BTreeMap<String, GraphNode> = BTreeMap::new();
        for n in &vault.notes {
            nodes.insert(
                n.path.clone(),
                GraphNode {
                    id: n.path.clone(),
                    label: n.title.clone(),
                    kind: NodeKind::Note,
                    degree: 0,
                },
            );
        }
        let mut edges: BTreeMap<(String, String), usize> = BTreeMap::new();
        for (src, dsts) in &self.resolved {
            for (dst, count) in dsts {
                if !is_markdown(dst) {
                    if !opts.attachments {
                        continue;
                    }
                    nodes.entry(dst.clone()).or_insert_with(|| GraphNode {
                        id: dst.clone(),
                        label: dst.rsplit('/').next().unwrap_or(dst).to_string(),
                        kind: NodeKind::Attachment,
                        degree: 0,
                    });
                }
                *edges.entry((src.clone(), dst.clone())).or_default() += count;
            }
        }
        if opts.unresolved {
            for (src, texts) in &self.unresolved {
                for (text, count) in texts {
                    let id = format!("unresolved:{text}");
                    nodes.entry(id.clone()).or_insert_with(|| GraphNode {
                        id: id.clone(),
                        label: text.clone(),
                        kind: NodeKind::Unresolved,
                        degree: 0,
                    });
                    *edges.entry((src.clone(), id)).or_default() += count;
                }
            }
        }
        if opts.tags {
            for n in &vault.notes {
                for t in &n.meta.tags {
                    let id = format!("tag:{}", t.to_lowercase());
                    nodes.entry(id.clone()).or_insert_with(|| GraphNode {
                        id: id.clone(),
                        label: format!("#{t}"),
                        kind: NodeKind::Tag,
                        degree: 0,
                    });
                    *edges.entry((n.path.clone(), id)).or_default() += 1;
                }
            }
        }
        for (s, d) in edges.keys() {
            if let Some(n) = nodes.get_mut(s) {
                n.degree += 1;
            }
            if let Some(n) = nodes.get_mut(d) {
                n.degree += 1;
            }
        }
        if !opts.orphans {
            nodes.retain(|_, n| n.degree > 0);
        }
        GraphData {
            nodes: nodes.into_values().collect(),
            edges: edges
                .into_iter()
                .map(|((source, target), weight)| GraphEdge {
                    source,
                    target,
                    weight,
                })
                .collect(),
        }
    }

    /// Notes within `depth` link-hops of `path` (both directions), including `path`.
    pub fn neighborhood(&self, path: &str, depth: usize) -> BTreeSet<String> {
        let mut seen: BTreeSet<String> = BTreeSet::from([path.to_string()]);
        let mut frontier = vec![path.to_string()];
        for _ in 0..depth {
            let mut next = Vec::new();
            for p in &frontier {
                let outs = self.resolved.get(p).into_iter().flat_map(|m| m.keys().cloned());
                let ins = self
                    .resolved
                    .iter()
                    .filter(|(_, ds)| ds.contains_key(p))
                    .map(|(s, _)| s.clone());
                for n in outs.chain(ins).collect::<Vec<_>>() {
                    if seen.insert(n.clone()) {
                        next.push(n);
                    }
                }
            }
            frontier = next;
        }
        seen
    }
}

#[derive(Debug, Clone, Copy)]
pub struct GraphOptions {
    pub attachments: bool,
    pub unresolved: bool,
    pub tags: bool,
    pub orphans: bool,
}

impl Default for GraphOptions {
    fn default() -> Self {
        GraphOptions {
            attachments: false,
            unresolved: false,
            tags: false,
            orphans: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    Note,
    Attachment,
    Unresolved,
    Tag,
    /// A concept note from the AI layer (not a file).
    Concept,
}

#[derive(Debug, Clone, Serialize)]
pub struct GraphNode {
    pub id: String,
    pub label: String,
    pub kind: NodeKind,
    pub degree: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    pub weight: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct GraphData {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault() -> Vault {
        Vault::from_notes([
            ("Hub.md", "[[A]] [[A]] [[B#H]] [[Ghost]] [[#Self]]"),
            ("A.md", "back to [[Hub]] #tagged"),
            ("B.md", "no links"),
            ("Lonely.md", "nothing"),
        ])
    }

    #[test]
    fn counts_and_backlinks() {
        let v = vault();
        let idx = LinkIndex::build(&v);
        assert_eq!(idx.resolved["Hub.md"]["A.md"], 2);
        assert_eq!(idx.resolved["Hub.md"]["B.md"], 1);
        assert!(
            !idx.resolved["Hub.md"].contains_key("Hub.md"),
            "self-links excluded"
        );
        assert_eq!(idx.unresolved["Hub.md"]["Ghost"], 1);
        let bl = idx.backlinks("A.md");
        assert_eq!(bl.keys().copied().collect::<Vec<_>>(), vec!["Hub.md"]);
        assert_eq!(bl["Hub.md"].len(), 2);
    }

    #[test]
    fn orphans_and_dead_ends() {
        let v = vault();
        let idx = LinkIndex::build(&v);
        assert_eq!(idx.orphans(&v), vec!["Lonely.md"]);
        assert_eq!(idx.dead_ends(&v), vec!["B.md", "Lonely.md"]);
    }

    #[test]
    fn graph_options() {
        let v = vault();
        let idx = LinkIndex::build(&v);
        let g = idx.graph(&v, GraphOptions::default());
        assert_eq!(g.nodes.len(), 4);
        assert_eq!(g.edges.len(), 3);
        let g2 = idx.graph(
            &v,
            GraphOptions {
                unresolved: true,
                tags: true,
                orphans: false,
                attachments: false,
            },
        );
        assert!(
            g2.nodes
                .iter()
                .any(|n| n.kind == NodeKind::Unresolved && n.label == "Ghost")
        );
        assert!(
            g2.nodes
                .iter()
                .any(|n| n.kind == NodeKind::Tag && n.label == "#tagged")
        );
        assert!(!g2.nodes.iter().any(|n| n.id == "Lonely.md"));
    }

    #[test]
    fn neighborhood_both_directions() {
        let v = vault();
        let idx = LinkIndex::build(&v);
        let n = idx.neighborhood("B.md", 1);
        assert_eq!(n, BTreeSet::from(["B.md".to_string(), "Hub.md".to_string()]));
        let n2 = idx.neighborhood("B.md", 2);
        assert!(n2.contains("A.md"));
    }
}
