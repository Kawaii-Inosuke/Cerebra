//! `cerebra`: command-line access to Cerebra's knowledge engine, for development and testing.
//!
//! Examples:
//!   cerebra <library> info
//!   cerebra <library> backlinks "Cell Structure"
//!   cerebra <library> search "osmosis" --collection Biology
//!   cerebra <library> upload Biology ~/Downloads/unit3.pdf
//!   cerebra <library> graph --unresolved > graph.json

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Instant;

use anyhow::{Context, Result, bail};
use cerebra_core::chunk::chunk_note;
use cerebra_core::collection::collections;
use cerebra_core::graph::GraphOptions;
use cerebra_core::render::Renderer;
use cerebra_core::store::Store;
use cerebra_core::{LinkIndex, Vault};
use clap::{Parser, Subcommand};
use serde_json::json;

mod serve;

#[derive(Parser)]
#[command(
    name = "cerebra",
    about = "Cerebra knowledge engine (Markdown notes with [[links]])"
)]
struct Cli {
    /// Path to the library folder
    library: PathBuf,
    /// Folder with the local AI models (scripts/fetch-models.mjs downloads them)
    #[arg(long, global = true, default_value = "models")]
    models: PathBuf,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Counts, collections and timings
    Info,
    /// Notes linking to the given note (title or path)
    Backlinks { note: String },
    /// Links going out of the given note
    Outgoing { note: String },
    /// Links whose target doesn't exist
    Unresolved,
    /// Notes with no links in or out
    Orphans,
    /// Notes with no outgoing links
    Deadends,
    /// Graph data as JSON (nodes + edges)
    Graph {
        #[arg(long)]
        unresolved: bool,
        #[arg(long)]
        tags: bool,
        #[arg(long)]
        attachments: bool,
        #[arg(long)]
        hide_orphans: bool,
    },
    /// Full-text search
    Search {
        query: String,
        #[arg(long)]
        collection: Option<String>,
        #[arg(long, default_value_t = 8)]
        limit: usize,
    },
    /// The context pack an AI chat would get for a question
    Context {
        question: String,
        #[arg(long)]
        collection: Option<String>,
    },
    /// Add a file (PDF, Word, PowerPoint, picture, Markdown, text) to a collection
    Upload { collection: String, file: PathBuf },
    /// Copy an Obsidian vault or folder in as a new collection
    Import { folder: PathBuf, collection: String },
    /// Rendered, sanitised HTML of a note
    Render { note: String },
    /// Search/retrieval chunks of a note
    Chunks { note: String },
    /// Per-note outgoing/backlinks/unresolved/tags as JSON, for compat fixtures
    CompatReport,
    /// Save a collection as a `.cerebra` share file
    Export {
        collection: String,
        file: PathBuf,
        #[arg(long)]
        password: Option<String>,
        /// Leave out original files (PDFs, slides, pictures)
        #[arg(long)]
        no_files: bool,
    },
    /// Import a `.cerebra` share file as a new collection
    ImportShare {
        file: PathBuf,
        #[arg(long)]
        collection: Option<String>,
        #[arg(long)]
        password: Option<String>,
    },
    /// MCP server over stdio, for AI apps (Claude Desktop, Codex…) and Cerebra's agents
    Mcp {
        /// Also offer the agent-only tools
        #[arg(long)]
        agent: bool,
        /// Hide a collection completely (repeatable)
        #[arg(long)]
        exclude: Vec<String>,
    },
    /// Browser preview of the app at http://127.0.0.1:<port> (development only)
    Serve {
        /// Built UI folder (`npm run build` creates it)
        #[arg(long, default_value = "ui/dist")]
        ui: PathBuf,
        #[arg(long, default_value_t = 1430)]
        port: u16,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    cerebra_core::semantic::set_models_dir(cli.models.clone());
    cerebra_core::ocr::set_models_dir(cli.models.clone());

    // Commands that change the library run before it is loaded.
    match &cli.cmd {
        Cmd::Upload { collection, file } => {
            let bytes = std::fs::read(file).with_context(|| format!("reading {}", file.display()))?;
            let name = file
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let r = cerebra_core::upload::save_upload(&cli.library, collection, &name, &bytes)?;
            println!("Note: {}", r.note_path);
            if let Some(a) = r.attachment_path {
                println!("File: {a}");
            }
            return Ok(());
        }
        Cmd::Import { folder, collection } => {
            let r = cerebra_core::import::import_folder(&cli.library, folder, collection)?;
            println!("{}", serde_json::to_string_pretty(&r)?);
            return Ok(());
        }
        Cmd::Export {
            collection,
            file,
            password,
            no_files,
        } => {
            let mut s = cerebra_core::session::Session::open(&cli.library).map_err(|e| anyhow::anyhow!(e))?;
            let path = std::path::absolute(file)?;
            let r = s
                .dispatch("share_export", json!({ "collection": collection, "path": path, "password": password, "include_files": !no_files }))
                .map_err(|e| anyhow::anyhow!(e))?;
            println!("{}", serde_json::to_string_pretty(&r)?);
            return Ok(());
        }
        Cmd::ImportShare {
            file,
            collection,
            password,
        } => {
            let mut s = cerebra_core::session::Session::open(&cli.library).map_err(|e| anyhow::anyhow!(e))?;
            let r = s
                .dispatch(
                    "share_import",
                    json!({ "path": file, "collection": collection, "password": password }),
                )
                .map_err(|e| anyhow::anyhow!(e))?;
            println!("{}", serde_json::to_string_pretty(&r)?);
            return Ok(());
        }
        Cmd::Mcp { agent, exclude } => {
            let mut server = cerebra_core::mcp::Server::open(&cli.library, *agent)
                .map_err(|e| anyhow::anyhow!(e))?
                .excluding(exclude.clone());
            let stdin = std::io::stdin();
            cerebra_core::mcp::serve(&mut server, stdin.lock(), std::io::stdout())?;
            return Ok(());
        }
        Cmd::Serve { ui, port } => {
            let session =
                cerebra_core::session::Session::open(&cli.library).map_err(|e| anyhow::anyhow!(e))?;
            return serve::serve(session, ui, *port);
        }
        _ => {}
    }

    let t0 = Instant::now();
    let vault = Vault::load(&cli.library).with_context(|| format!("loading {}", cli.library.display()))?;
    let load_ms = t0.elapsed().as_millis();
    let t1 = Instant::now();
    let idx = LinkIndex::build(&vault);
    let link_ms = t1.elapsed().as_millis();

    let find = |q: &str| -> Result<&cerebra_core::Note> {
        match vault.find_note(q) {
            Some(n) => Ok(n),
            None => bail!("note not found: {q}"),
        }
    };
    let store = || -> Result<Store> {
        let mut s = Store::open_in_memory()?;
        s.rebuild(&vault, &idx)?;
        Ok(s)
    };

    match cli.cmd {
        Cmd::Info => {
            let unresolved: usize = idx.unresolved.values().flat_map(|m| m.values()).sum();
            let resolved: usize = idx.resolved.values().flat_map(|m| m.values()).sum();
            println!("library: {}", cli.library.display());
            println!("files: {}", vault.files.len());
            println!("notes: {}", vault.notes.len());
            println!("links: {resolved} resolved, {unresolved} unresolved");
            println!("orphans: {}", idx.orphans(&vault).len());
            println!("dead ends: {}", idx.dead_ends(&vault).len());
            let bad = vault
                .notes
                .iter()
                .filter(|n| n.meta.frontmatter_error.is_some())
                .count();
            println!("bad frontmatter: {bad}");
            println!("collections:");
            for (name, count) in collections(&vault) {
                println!("  {name} ({count})");
            }
            println!("load: {load_ms} ms, links: {link_ms} ms");
        }
        Cmd::Backlinks { note } => {
            let n = find(&note)?;
            for (src, edges) in idx.backlinks(&n.path) {
                let lines: Vec<String> = edges.iter().map(|e| (e.line + 1).to_string()).collect();
                println!("{src}  (line {})", lines.join(", "));
            }
        }
        Cmd::Outgoing { note } => {
            let n = find(&note)?;
            for e in idx.outgoing(&n.path) {
                let to = e
                    .dst
                    .clone()
                    .unwrap_or_else(|| format!("✗ unresolved: {}", e.target_text));
                println!(
                    "L{:<4} {}{} → {to}",
                    e.line + 1,
                    if e.embed { "!" } else { "" },
                    e.target_text
                );
            }
        }
        Cmd::Unresolved => {
            for (src, texts) in &idx.unresolved {
                for (t, c) in texts {
                    println!("{src}  →  [[{t}]] ×{c}");
                }
            }
        }
        Cmd::Orphans => idx.orphans(&vault).iter().for_each(|p| println!("{p}")),
        Cmd::Deadends => idx.dead_ends(&vault).iter().for_each(|p| println!("{p}")),
        Cmd::Graph {
            unresolved,
            tags,
            attachments,
            hide_orphans,
        } => {
            let g = idx.graph(
                &vault,
                GraphOptions {
                    unresolved,
                    tags,
                    attachments,
                    orphans: !hide_orphans,
                },
            );
            println!("{}", serde_json::to_string_pretty(&g)?);
        }
        Cmd::Search {
            query,
            collection,
            limit,
        } => {
            let s = store()?;
            for h in s.search(&query, collection.as_deref(), limit)? {
                println!(
                    "{:>7.2}  {}  › {} (L{})\n         {}",
                    h.score,
                    h.path,
                    h.heading_path,
                    h.line + 1,
                    h.snippet.replace('\n', " ")
                );
            }
        }
        Cmd::Context { question, collection } => {
            let s = store()?;
            let pack = cerebra_core::context::build_context(
                &vault,
                &idx,
                &s,
                &question,
                collection.as_deref(),
                cerebra_core::context::DEFAULT_BUDGET,
            )?;
            println!("{}\n\n({} tokens)", pack.text, pack.tokens);
        }
        Cmd::Render { note } => {
            let n = find(&note)?;
            println!("{}", Renderer::new(&vault).render(&n.path).unwrap_or_default());
        }
        Cmd::Chunks { note } => {
            let n = find(&note)?;
            println!("{}", serde_json::to_string_pretty(&chunk_note(n))?);
        }
        Cmd::CompatReport => {
            let mut report = BTreeMap::new();
            for n in &vault.notes {
                let mut outgoing: Vec<String> = idx
                    .resolved
                    .get(&n.path)
                    .map(|m| m.keys().cloned().collect())
                    .unwrap_or_default();
                outgoing.sort();
                let backlinks: Vec<&str> = idx.backlinks(&n.path).keys().copied().collect();
                let unresolved: Vec<String> = idx
                    .unresolved
                    .get(&n.path)
                    .map(|m| m.keys().cloned().collect())
                    .unwrap_or_default();
                report.insert(
                    n.path.clone(),
                    json!({
                        "outgoing": outgoing,
                        "backlinks": backlinks,
                        "unresolved": unresolved,
                        "tags": n.meta.tags,
                        "aliases": n.meta.aliases,
                    }),
                );
            }
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        Cmd::Upload { .. }
        | Cmd::Import { .. }
        | Cmd::Serve { .. }
        | Cmd::Mcp { .. }
        | Cmd::Export { .. }
        | Cmd::ImportShare { .. } => unreachable!("handled above"),
    }
    Ok(())
}
