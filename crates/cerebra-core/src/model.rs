//! Plain data types shared by every part of the engine.

use serde::{Deserialize, Serialize};

/// One `[[wikilink]]`, `![[embed]]` or local `[markdown](link)` found in a note.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkRef {
    /// Link target as written, without the subpath (e.g. `Folder/Note`).
    pub target: String,
    /// `#Heading` or `#^block-id`, including the leading `#`. Empty if none.
    pub subpath: String,
    /// Text after `|`, if any. For embeds this may be a size like `300`.
    pub display: Option<String>,
    /// `true` for `![[…]]` / `![](…)`.
    pub embed: bool,
    pub kind: LinkKind,
    /// 0-based line in the file.
    pub line: usize,
    /// Byte range of the whole link in the original text.
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkKind {
    Wiki,
    Markdown,
    /// A wikilink written inside a frontmatter property value.
    Frontmatter,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Heading {
    pub level: u8,
    pub text: String,
    pub line: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockId {
    pub id: String,
    pub line: usize,
}

/// Everything the parser extracts from one markdown file.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct NoteMeta {
    /// Parsed YAML frontmatter as JSON (`null` if none or invalid).
    pub frontmatter: serde_json::Value,
    /// Set when frontmatter exists but is not valid YAML.
    pub frontmatter_error: Option<String>,
    pub aliases: Vec<String>,
    /// Tags without the leading `#`, de-duplicated, original case preserved.
    pub tags: Vec<String>,
    pub headings: Vec<Heading>,
    pub blocks: Vec<BlockId>,
    pub links: Vec<LinkRef>,
    /// Byte offset where the body starts (after frontmatter).
    pub body_start: usize,
}
