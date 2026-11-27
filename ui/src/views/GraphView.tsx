import { ArrowRight, Crosshair, Maximize2, Minus, Network, Plus, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AiConnection, GraphData, NoteView } from "../api";
import { ConnectionDetails } from "../components/ConnectionDetails";
import { GraphCanvas } from "../components/GraphCanvas";
import { edgeKey, type EdgeInput, type GraphEngine, type NodeInput } from "../components/graphEngine";
import { PanelHeader, RightPanel } from "../components/RightPanel";
import { Button, Dot, EmptyState, SectionLabel, Spinner, TagChip } from "../components/ui";
import { useActions } from "../actions";
import { LibraryPicker } from "../switcher";
import { useAgentsOptional } from "../agents";
import type { AiConcept } from "../api";
import { useToast } from "../components/Toast";
import { madeByLabel } from "../lib/ai";
import { useApi, useLibrary } from "../context";
import { colorVar } from "../lib/colors";
import { conceptEnd, findConnection } from "../lib/graphAi";
import { navigate } from "../lib/router";
import { cx, errorMessage, plural } from "../lib/util";

export function GraphView({ focus, initialCollection = null }: { focus?: string; initialCollection?: string | null }) {
  const api = useApi();
  const lib = useLibrary();
  const actions = useActions();
  const [collection, setCollection] = useState<string | null>(initialCollection);
  const [unresolved, setUnresolved] = useState(false);
  const [tags, setTags] = useState(false);
  const [orphans, setOrphans] = useState(true);
  const [depth, setDepth] = useState(2);
  const [search, setSearch] = useState("");
  const [showAi, setShowAi] = useState(true);
  const [data, setData] = useState<GraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<NodeInput | null>(null);
  const engine = useRef<GraphEngine | null>(null);
  const agents = useAgentsOptional();
  const [edge, setEdge] = useState<EdgeInput | null>(null);
  const [connections, setConnections] = useState<AiConnection[]>([]);

  // The AI connections behind the violet lines, for the side panel when one is clicked.
  useEffect(() => {
    if (!showAi) return;
    let live = true;
    api
      .aiList({ collection })
      .then((r) => live && setConnections(r.connections))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [api, showAi, collection, agents?.aiVersion]);

  const connection = edge && data ? findConnection(edge, data.nodes, connections) : null;

  const selectEdge = (e: EdgeInput | null) => {
    if (e && data) {
      // A line to a concept: show the concept itself.
      const key = conceptEnd(e, data.nodes);
      const concept = key ? data.nodes.find((n) => n.key === key) : null;
      if (concept) {
        setEdge(null);
        setSelected({ id: concept.key, label: concept.label, kind: "concept", color: "", noteId: null, degree: concept.degree, dim: false });
        return;
      }
    }
    setEdge(e);
    if (e) setSelected(null);
  };

  useEffect(() => {
    let live = true;
    api
      .graph({ collection, unresolved, tags, hide_orphans: !orphans, focus: focus ?? null, depth: focus ? depth : undefined })
      .then((d) => {
        if (!live) return;
        setData(d);
        setError(null);
      })
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [api, collection, unresolved, tags, orphans, focus, depth, lib.info, agents?.aiVersion]);

  const matchCount = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q && data ? data.nodes.filter((n) => n.label.toLowerCase().includes(q)).length : 0;
  }, [search, data]);

  const focusTitle = focus ? lib.notes.find((n) => n.id === focus)?.title : null;

  return (
    <div className="flex min-h-0 flex-1">
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-bg">
        <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-1.5 text-[12.5px] text-muted-strong" data-testid="graph-header">
          <span className="flex items-center gap-0.5">
            Showing:
            <LibraryPicker variant="inline" fallbackName={lib.info?.name} />
            <span aria-hidden className="mx-1 text-muted">·</span>
            <span className="text-fg">{collection ?? "All collections"}</span>
          </span>
          <span aria-hidden className="h-4 w-px bg-border" />
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Collection filter">
            <Chip active={collection === null} onClick={() => setCollection(null)}>
              All
            </Chip>
            {lib.collections.map((c) => (
              <Chip key={c.name} active={collection === c.name} onClick={() => setCollection(collection === c.name ? null : c.name)}>
                <Dot color={colorVar(c.name, lib.ordered)} />
                {c.name}
              </Chip>
            ))}
          </div>
        </div>
        <div className="relative min-h-0 flex-1">
        {error ? (
          <div className="flex h-full items-center justify-center">
            <EmptyState title="The graph couldn't be drawn">{error}</EmptyState>
          </div>
        ) : !data ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : data.nodes.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <EmptyState
              icon={<Network className="size-5" />}
              title={lib.info?.notes ? "Nothing to show with these filters" : "Your graph is empty"}
              action={lib.info?.notes ? undefined : <Button variant="primary" onClick={() => actions.chooseAndUpload()}>Upload files</Button>}
            >
              {lib.info?.notes ? "Try another collection, or turn on orphans." : "Add notes and every [[link]] between them appears here."}
            </EmptyState>
          </div>
        ) : (
          <GraphCanvas
            data={data}
            ordered={lib.ordered}
            focus={focus ?? null}
            search={search}
            selected={selected?.id ?? null}
            engineRef={engine}
            showAi={showAi}
            label={`Graph of ${plural(data.nodes.length, "node")} and ${plural(data.edges.length, "link")}`}
            onSelect={(n) => {
              setSelected(n);
              if (n) setEdge(null);
            }}
            onSelectEdge={selectEdge}
            selectedEdge={edge ? edgeKey(edge) : null}
            onOpen={(n) => n.noteId && navigate({ name: "note", id: n.noteId })}
          />
        )}

        {/* Top-left: search highlight + focus */}
        <div className="pointer-events-none absolute top-3 left-3 flex flex-col gap-2">
          <label className="pointer-events-auto flex h-8 w-[260px] items-center gap-2 rounded-input border border-border bg-surface px-2.5 shadow-float focus-within:border-accent">
            <Search className="size-3.5 text-muted" aria-hidden />
            <span className="sr-only">Highlight notes</span>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Highlight notes…" className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted" />
            {search && <span className="text-[11.5px] text-muted tabular-nums">{matchCount}</span>}
          </label>
          {focus && (
            <div className="pointer-events-auto flex items-center gap-2 rounded-input border border-border bg-surface py-1 pr-1 pl-2.5 text-[12.5px] shadow-float">
              <Crosshair className="size-3.5 text-accent" aria-hidden />
              <span className="max-w-[160px] truncate text-fg">{focusTitle ?? "Focused note"}</span>
              <span className="text-muted">depth</span>
              <span className="flex gap-0.5" role="group" aria-label="Depth">
                {[1, 2, 3].map((d) => (
                  <button key={d} type="button" aria-pressed={depth === d} onClick={() => setDepth(d)} className={cx("size-6 rounded-md text-[12px]", depth === d ? "bg-accent-soft font-medium text-fg" : "text-muted hover:bg-hover")}>
                    {d}
                  </button>
                ))}
              </span>
              <button type="button" aria-label="Show the whole graph" onClick={() => navigate({ name: "graph" })} className="rounded-md p-1 text-muted hover:bg-hover hover:text-fg">
                <X className="size-3.5" />
              </button>
            </div>
          )}
        </div>

        {/* Bottom-left: filters */}
        <div className="absolute right-16 bottom-3 left-3 flex flex-col items-start gap-2">
          <div className="flex gap-1.5 rounded-card border border-border bg-surface p-1.5 shadow-float" role="group" aria-label="Show">
            <Chip active={orphans} onClick={() => setOrphans(!orphans)} toggle>
              Orphans
            </Chip>
            <Chip active={unresolved} onClick={() => setUnresolved(!unresolved)} toggle>
              Unresolved links
            </Chip>
            <Chip active={tags} onClick={() => setTags(!tags)} toggle>
              Tags
            </Chip>
            <Chip active={showAi} onClick={() => setShowAi(!showAi)} toggle title="Violet arrows are connections the AI found (dashed = not reviewed yet). Click one to see why.">
              AI connections
            </Chip>
          </div>
        </div>

        {/* Bottom-right: zoom */}
        <div className="absolute right-3 bottom-3 flex flex-col overflow-hidden rounded-card border border-border bg-surface shadow-float">
          <IconBtn label="Zoom in" onClick={() => engine.current?.zoomBy(1.3)}>
            <Plus className="size-4" />
          </IconBtn>
          <IconBtn label="Zoom out" onClick={() => engine.current?.zoomBy(1 / 1.3)}>
            <Minus className="size-4" />
          </IconBtn>
          <IconBtn label="Fit to screen" onClick={() => engine.current?.fit()}>
            <Maximize2 className="size-3.5" />
          </IconBtn>
        </div>
        </div>
      </main>
      <RightPanel label="Selection">
        {connection ? <ConnectionDetails c={connection} onClose={() => setEdge(null)} /> : <Preview node={selected} onClose={() => setSelected(null)} />}
      </RightPanel>
    </div>
  );
}

function Chip({ active, onClick, children, toggle, disabled, title }: { active: boolean; onClick: () => void; children: ReactNode; toggle?: boolean; disabled?: boolean; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      disabled={disabled}
      title={title}
      className={cx(
        "inline-flex h-7 items-center gap-1.5 rounded-input px-2.5 text-[12.5px] transition-colors duration-150",
        active ? "bg-hover font-medium text-fg ring-1 ring-border-strong" : "text-muted-strong hover:bg-hover hover:text-fg",
        disabled && "opacity-50 hover:bg-transparent",
      )}
    >
      {toggle && <span aria-hidden className={cx("size-1.5 rounded-full", active ? "bg-accent" : "bg-border-strong")} />}
      {children}
    </button>
  );
}

function IconBtn({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="flex size-8 items-center justify-center text-muted-strong transition-colors hover:bg-hover hover:text-fg">
      {children}
    </button>
  );
}

function Preview({ node, onClose }: { node: NodeInput | null; onClose: () => void }) {
  const api = useApi();
  const lib = useLibrary();
  const [note, setNote] = useState<NoteView | null>(null);
  const [loading, setLoading] = useState(false);
  const noteId = node?.noteId ?? null;

  useEffect(() => {
    setNote(null);
    if (!noteId) return;
    let live = true;
    setLoading(true);
    api
      .getNote(noteId)
      .then((n) => live && setNote(n))
      .catch(() => {})
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [api, noteId]);

  if (node?.kind === "concept") return <ConceptPreview id={node.id.replace(/^concept:/, "")} label={node.label} onClose={onClose} />;
  if (!node) {
    return (
      <>
        <PanelHeader>Preview</PanelHeader>
        <EmptyState icon={<Network className="size-5" />} title="Click a note to preview it">
          Click a violet arrow to see how two notes are connected and why. Double-click a note to open it; drag to move, scroll to zoom, double-click empty space to fit.
        </EmptyState>
      </>
    );
  }
  const summary = lib.notes.find((n) => n.id === noteId);
  const plain = note ? toPlain(note.text) : "";
  const excerpt = plain.slice(0, 420);

  return (
    <>
      <PanelHeader>
        <span className="flex-1 truncate">{node.kind === "note" ? "Note" : node.kind === "tag" ? "Tag" : node.kind === "unresolved" ? "Missing note" : "File"}</span>
        <button type="button" onClick={onClose} aria-label="Clear selection" className="rounded-md p-1 text-muted hover:bg-hover hover:text-fg">
          <X className="size-3.5" />
        </button>
      </PanelHeader>
      <div className="flex flex-col gap-4 overflow-y-auto p-4">
        <div>
          <h2 className="text-[16px] font-semibold tracking-[-0.01em] text-fg">{node.label}</h2>
          {summary && (
            <p className="mt-1 flex items-center gap-1.5 text-[12.5px] text-muted">
              <Dot color={colorVar(summary.collection, lib.ordered)} />
              {summary.collection ?? "Inbox"} · {plural(node.degree, "link")}
            </p>
          )}
          {node.kind === "unresolved" && <p className="mt-1 text-[12.5px] text-muted-strong">Other notes link to this name, but there's no note for it yet.</p>}
        </div>
        {noteId && (
          <div className="flex gap-2">
            <Button variant="primary" size="sm" onClick={() => navigate({ name: "note", id: noteId })}>
              Open note <ArrowRight className="size-3.5" aria-hidden />
            </Button>
            <Button size="sm" onClick={() => navigate({ name: "graph", focus: noteId })}>
              <Crosshair className="size-3.5" aria-hidden /> Focus
            </Button>
          </div>
        )}
        {loading && <Spinner />}
        {note && (
          <>
            {note.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {note.tags.map((t) => (
                  <TagChip key={t} tag={t} />
                ))}
              </div>
            )}
            {excerpt && <p className="text-[13px] leading-relaxed whitespace-pre-line text-muted-strong">{excerpt}{plain.length > 420 ? "…" : ""}</p>}
            {note.backlinks.length > 0 && (
              <section>
                <SectionLabel className="mb-1.5">Linked from</SectionLabel>
                <ul className="flex flex-col gap-0.5">
                  {note.backlinks.slice(0, 8).map((b) => (
                    <li key={b.note_id}>
                      <button type="button" onClick={() => navigate({ name: "note", id: b.note_id })} className="w-full truncate rounded-md px-2 py-1 text-left text-[13px] text-fg hover:bg-hover">
                        {b.title}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </>
  );
}

/** Markdown → readable plain text for the preview excerpt. */
function toPlain(md: string): string {
  return md
    .replace(/^---[\s\S]*?---\s*/, "")
    .replace(/^#\s.*$/m, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
    .replace(/\[\[([^\]#]*)(#[^\]]*)?\]\]/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]{1,3}([^*_`~]+)[*_`~]{1,3}/g, "$1")
    .replace(/^\|.*\|$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function ConceptPreview({ id, label, onClose }: { id: string; label: string; onClose: () => void }) {
  const api = useApi();
  const lib = useLibrary();
  const toast = useToast();
  const agents = useAgentsOptional();
  const [concept, setConcept] = useState<AiConcept | null>(null);
  useEffect(() => {
    let live = true;
    api
      .aiList()
      .then((r) => live && setConcept(r.concepts.find((k) => k.id === id) ?? null))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [api, id]);
  const promote = async () => {
    try {
      const r = await api.aiPromoteConcept(id);
      await lib.refresh();
      agents?.bumpAi();
      onClose();
      toast.show({ kind: "success", title: `“${label}” is now a note`, action: r.note_id ? { label: "Open note", onClick: () => navigate({ name: "note", id: r.note_id! }) } : undefined });
    } catch (e) {
      toast.show({ kind: "error", title: "Couldn't make the note", description: errorMessage(e) });
    }
  };
  return (
    <>
      <PanelHeader>
        <span className="flex-1 truncate">Concept</span>
        <button type="button" onClick={onClose} aria-label="Clear selection" className="rounded-md p-1 text-muted hover:bg-hover hover:text-fg">
          <X className="size-3.5" />
        </button>
      </PanelHeader>
      <div className="flex flex-col gap-4 overflow-y-auto p-4">
        <div className="flex items-center gap-2">
          <span aria-hidden className="size-3 rounded-full border-2 border-accent" />
          <h2 className="text-[16px] font-semibold tracking-[-0.01em] text-fg">{label}</h2>
        </div>
        {concept ? (
          <>
            <p className="text-[13px] leading-relaxed text-muted-strong">{concept.summary}</p>
            <section>
              <SectionLabel className="mb-1.5">Notes about it</SectionLabel>
              <ul className="flex flex-col gap-0.5">
                {concept.notes.map((p) => {
                  const n = lib.notes.find((x) => x.path === p);
                  return (
                    <li key={p}>
                      <button type="button" disabled={!n} onClick={() => n && navigate({ name: "note", id: n.id })} className="w-full truncate rounded-md px-2 py-1 text-left text-[13px] text-fg hover:bg-hover">
                        {n?.title ?? p}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
            <p className="text-[11.5px] text-muted">
              {madeByLabel(concept.made_by)} · {concept.status}
            </p>
            <Button variant="primary" size="sm" onClick={() => void promote()}>
              Keep as real note
            </Button>
          </>
        ) : (
          <Spinner />
        )}
      </div>
    </>
  );
}
