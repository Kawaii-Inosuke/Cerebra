//! Cerebra core: an Obsidian-compatible knowledge engine.
//!
//! Clean-room implementation built only from public documentation and black-box
//! fixtures. See `docs/05-LINK-ENGINE.md`.

pub mod ai_layer;
pub mod api;
pub mod chunk;
pub mod collection;
pub mod context;
pub mod extract;
pub mod graph;
pub mod import;
pub mod jobs;
pub mod mask;
pub mod mcp;
pub mod model;
pub mod ocr;
pub mod parse;
pub mod render;
pub mod resolve;
pub mod retrieve;
pub mod semantic;
pub mod session;
pub mod share;
pub mod store;
pub mod time;
pub mod upload;
pub mod vault;

pub use graph::{GraphData, GraphOptions, LinkIndex};
pub use model::{LinkKind, LinkRef, NoteMeta};
pub use vault::{Note, Vault};
