import * as Tabs from "@radix-ui/react-tabs";
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, FileText, Link2, Network, Pencil, Share2, Sparkles, X } from "lucide-react";
import { useShareOptional } from "../share";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { AiStatus, GraphData, NoteAiConnection, NoteView as Note } from "../api";
import { GraphCanvas } from "../components/GraphCanvas";
import { RightPanel } from "../components/RightPanel";
import { useToast } from "../components/Toast";
import { Button, Confidence, Dot, EmptyState, SectionLabel, Spinner, TagChip, TypeChip } from "../components/ui";
import { useActionsOptional } from "../actions";
import { useAgentsOptional } from "../agents";
import { useApi, useLibrary } from "../context";
import { madeByLabel, typeLabel } from "../lib/ai";
import { colorVar } from "../lib/colors";
import { parseCerebraUrl, rewriteFileUrls, slugify } from "../lib/links";
import { navigate, routeHref } from "../lib/router";
import { basename, cx, errorMessage, modKey, plural } from "../lib/util";

// CodeMirror is only loaded when someone edits.
const Editor = lazy(() => import("../components/Editor").then((m) => ({ default: m.Editor })));

export function NoteView({ id, sub, startEditing = false }: { id: string; sub?: string; startEditing?: boolean }) {
  const api = useApi();
  const lib = useLibrary();
  const toast = useToast();
  const [note, setNote] = useState<Note | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(startEditing);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const reader = useRef<HTMLDivElement>(null);
  const { pushRecent, refresh } = lib;
  const agents = useAgentsOptional();
  const actions = useActionsOptional();
  const share = useShareOptional();

  useEffect(() => {
    let live = true;
    setError(null);
    api
      .getNote(id)
      .then((n) => {
        if (!live) return;
        setNote(n);
        setDraft(n.text);
        pushRecent(n.id);
      })
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
    // pushRecent is stable enough; re-running on it would refetch on every library refresh.
  }, [api, id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setEditing(startEditing);
    setConfirmDiscard(false);
  }, [id, startEditing]);

  // Reload the note when the library changes on disk (and we're not mid-edit).
  useEffect(() => {
    if (editing || !note) return;
    let live = true;
    api
      .getNote(id)
      .then((n) => live && n.html !== note.html && setNote(n))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [lib.info, agents?.aiVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const html = useMemo(() => (note ? rewriteFileUrls(note.html, api.fileUrl) : ""), [note, api]);
  const dirty = !!note && draft !== note.text;

  const scrollToHeading = useCallback((text: string, index?: number) => {
    const root = reader.current;
    if (!root) return;
    const hs = Array.from(root.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6"));
    const slug = slugify(text);
    const el =
      (slug ? document.getElementById(slug) : null) ??
      hs.find((h) => h.textContent?.trim().toLowerCase() === text.trim().toLowerCase()) ??
      (index !== undefined ? hs[index] : undefined);
    if (!el) return;
    el.scrollIntoView({ block: "start", behavior: "smooth" });
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
  }, []);

  useEffect(() => {
    if (note && sub && !editing) requestAnimationFrame(() => scrollToHeading(sub));
  }, [note, sub, editing, scrollToHeading]);

  const save = useCallback(async () => {
    if (!note || saving) return;
    setSaving(true);
    try {
      const n = await api.saveNote(note.id, draft);
      setNote(n);
      setDraft(n.text);
      setEditing(false);
      setConfirmDiscard(false);
      toast.show({ kind: "success", title: "Saved", duration: 2000 });
      if (n.id !== note.id) navigate({ name: "note", id: n.id }, true);
      void refresh();
    } catch (e) {
      toast.show({ kind: "error", title: "Couldn't save the note", description: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  }, [api, draft, note, refresh, saving, toast]);

  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, save]);

  const createFromLink = useCallback(
    async (title: string) => {
      try {
        const r = await api.newNote(title, note ? collectionOf(note.path) : null);
        await refresh();
        if (r.id) navigate({ name: "note", id: r.id, edit: true });
      } catch (e) {
        toast.show({ kind: "error", title: `Couldn't create “${title}”`, description: errorMessage(e) });
      }
    },
    [api, note, refresh, toast],
  );

  const onReaderClick = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    if (a.dataset.cerebraFile !== undefined) {
      e.preventDefault();
      const p = parseCerebraUrl(`cerebra://file/${a.dataset.cerebraFile}`);
      if (p?.kind === "file") void api.openLibraryFile(p.path);
      return;
    }
    const link = parseCerebraUrl(href);
    if (link) {
      e.preventDefault();
      if (link.kind === "note") {
        if (link.id === note?.id && link.sub) scrollToHeading(link.sub);
        else navigate(link.sub ? { name: "note", id: link.id, sub: link.sub } : { name: "note", id: link.id });
      } else if (link.kind === "embed") navigate({ name: "note", id: link.id });
      else if (link.kind === "file") void api.openLibraryFile(link.path);
      else
        toast.show({
          title: `“${link.text}” doesn't exist yet`,
          description: "Create it and this link will connect.",
          action: { label: "Create note", onClick: () => void createFromLink(link.text) },
        });
      return;
    }
    if (/^(https?:|mailto:)/.test(href)) {
      e.preventDefault();
      void api.openExternal(href);
    } else if (href.startsWith("#")) {
      e.preventDefault();
      scrollToHeading(decodeURIComponent(href.slice(1)));
    }
  };

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState icon={<FileText className="size-5" />} title="This note couldn't be opened" action={<Button onClick={() => navigate({ name: "home" })}>Go home</Button>}>
          {error === "note not found" ? "It may have been moved, renamed or deleted." : error}
        </EmptyState>
      </div>
    );
  }
  if (!note) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const collection = collectionOf(note.path);

  return (
    <div className="flex min-h-0 flex-1">
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-5 text-[12.5px]">
          <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-1.5 text-muted">
            <a href={routeHref({ name: "collection", collection })} className="flex items-center gap-1.5 rounded px-1 hover:text-fg">
              <Dot color={colorVar(collection, lib.ordered)} />
              {collection ?? "Inbox"}
            </a>
            <span aria-hidden>/</span>
            <span className="truncate text-fg">{note.title}</span>
            {dirty && <span className="ml-1 text-[11.5px] text-muted">· Unsaved changes</span>}
          </nav>
          {note.source_file && (
            <button
              type="button"
              onClick={() => void api.openLibraryFile(note.source_file!).catch((e) => toast.show({ kind: "error", title: "Couldn't open the original", description: errorMessage(e) }))}
              title="Open the original file"
              className="inline-flex h-7 max-w-[220px] items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 text-[12px] text-muted-strong transition-colors hover:border-border-strong hover:text-fg"
            >
              <FileText className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate">{basename(note.source_file)}</span>
              <ArrowUpRight className="size-3 shrink-0" aria-hidden />
            </button>
          )}
          {editing ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (dirty && !confirmDiscard) return setConfirmDiscard(true);
                  setDraft(note.text);
                  setEditing(false);
                  setConfirmDiscard(false);
                }}
              >
                <X className="size-3.5" aria-hidden />
                {confirmDiscard ? "Discard changes?" : "Cancel"}
              </Button>
              <Button size="sm" variant="primary" onClick={() => void save()} disabled={saving} aria-keyshortcuts="Control+S">
                <Check className="size-3.5" aria-hidden />
                {saving ? "Saving…" : "Save"}
                <span className="ml-1 text-[11px] opacity-70">{modKey}S</span>
              </Button>
            </>
          ) : (
            <>
              {share && collection && (
                <Button size="sm" variant="ghost" onClick={() => share.openExport(collection)} aria-label={`Share ${collection} as a file`} title={`Share ${collection} as a file`}>
                  <Share2 className="size-3.5" aria-hidden />
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => void actions?.connectNote(note.path, note.title)} disabled={!actions} title="Ask the agents to find valuable connections for this note">
                <Sparkles className="size-3.5 text-accent" aria-hidden />
                Connect this note
              </Button>
              <Button size="sm" onClick={() => setEditing(true)}>
                <Pencil className="size-3.5" aria-hidden />
                Edit
              </Button>
            </>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className={cx("mx-auto w-full px-8 pt-8 pb-24", editing ? "max-w-[860px]" : "max-w-[780px]")}>
            {editing ? (
              <Suspense fallback={<Spinner />}>
                <Editor value={draft} onChange={setDraft} onSave={() => void save()} titles={lib.notes.map((n) => n.title)} />
              </Suspense>
            ) : (
              <>
                {(note.tags.length > 0 || note.aliases.length > 0) && (
                  <div className="mb-5 flex flex-wrap items-center gap-1.5">
                    {note.tags.map((t) => (
                      <TagChip key={t} tag={t} />
                    ))}
                    {note.aliases.length > 0 && <span className="text-[12px] text-muted">also known as {note.aliases.join(", ")}</span>}
                  </div>
                )}
                {note.html.trim() ? (
                  <article ref={reader} className="reader" onClick={onReaderClick} dangerouslySetInnerHTML={{ __html: html }} />
                ) : (
                  <EmptyState icon={<Pencil className="size-5" />} title="This note is empty" action={<Button onClick={() => setEditing(true)}>Start writing</Button>} />
                )}
              </>
            )}
          </div>
        </div>
      </main>
      <RightPanel label="Note details">
        <NotePanel note={note} onHeading={(text, i) => (editing ? undefined : scrollToHeading(text, i))} />
      </RightPanel>
    </div>
  );
}

function collectionOf(path: string): string | null {
  const i = path.indexOf("/");
  return i > 0 ? path.slice(0, i) : null;
}

const tabClass =
  "relative h-11 px-1 text-[12.5px] font-medium text-muted transition-colors hover:text-fg data-[state=active]:text-fg data-[state=active]:after:absolute data-[state=active]:after:inset-x-0 data-[state=active]:after:bottom-[-1px] data-[state=active]:after:h-0.5 data-[state=active]:after:rounded-full data-[state=active]:after:bg-accent";

function NotePanel({ note, onHeading }: { note: Note; onHeading: (text: string, index: number) => void }) {
  return (
    <Tabs.Root defaultValue="connections" className="flex min-h-0 flex-1 flex-col">
      <Tabs.List aria-label="Note panel" className="flex shrink-0 gap-4 border-b border-border px-4">
        <Tabs.Trigger value="connections" className={tabClass}>
          Connections
        </Tabs.Trigger>
        <Tabs.Trigger value="outline" className={tabClass}>
          Outline
        </Tabs.Trigger>
        <Tabs.Trigger value="graph" className={tabClass}>
          Local graph
        </Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content value="connections" className="min-h-0 flex-1 overflow-y-auto px-4 py-4 outline-none">
        <Connections note={note} />
      </Tabs.Content>
      <Tabs.Content value="outline" className="min-h-0 flex-1 overflow-y-auto px-2 py-3 outline-none">
        {note.headings.length ? (
          <ul className="flex flex-col">
            {note.headings.map((h, i) => (
              <li key={`${h.line}-${i}`}>
                <button
                  type="button"
                  onClick={() => onHeading(h.text, i)}
                  className="w-full truncate rounded-md py-1 pr-2 text-left text-[13px] text-muted-strong transition-colors hover:bg-hover hover:text-fg"
                  style={{ paddingLeft: 8 + (h.level - 1) * 12 }}
                >
                  {h.text}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No headings">Add a line starting with # to give this note an outline.</EmptyState>
        )}
      </Tabs.Content>
      <Tabs.Content value="graph" className="min-h-0 flex-1 outline-none">
        <LocalGraph id={note.id} />
      </Tabs.Content>
    </Tabs.Root>
  );
}

function linkLabel(inner: string): string {
  const [target = "", alias] = inner.split("|");
  return alias ?? target.split("#")[0] ?? target;
}

function Mention({ text }: { text: string }) {
  const parts = text.split(/(\[\[[^\]]*\]\])/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("[[") ? (
          <span key={i} className="font-medium text-accent-text">
            {linkLabel(p.slice(2, -2))}
          </span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

function Connections({ note }: { note: Note }) {
  const resolved = note.outgoing.filter((l) => !l.unresolved);
  const unresolved = note.outgoing.filter((l) => l.unresolved);
  return (
    <div className="flex flex-col gap-6">
      <AiConnections note={note} />
      <section aria-labelledby="links-h">
        <div className="mb-2 flex items-center justify-between">
          <SectionLabel>
            <span id="links-h">Links</span>
          </SectionLabel>
          <span className="text-[11.5px] text-muted tabular-nums">{note.outgoing.length}</span>
        </div>
        {note.outgoing.length === 0 ? (
          <p className="text-[12.5px] text-muted">This note doesn't link anywhere yet. Type [[ while editing to add one.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {resolved.map((l) => (
              <li key={`${l.note_id}-${l.title}`}>
                <a
                  href={l.note_id ? routeHref({ name: "note", id: l.note_id }) : undefined}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-fg transition-colors hover:bg-hover"
                >
                  <Link2 className="size-3.5 shrink-0 text-muted" aria-hidden />
                  <span className="truncate">{l.title}</span>
                  {l.count > 1 && <span className="ml-auto text-[11.5px] text-muted">×{l.count}</span>}
                </a>
              </li>
            ))}
            {unresolved.map((l) => (
              <li key={`u-${l.title}`} className="flex items-center gap-2 px-2 py-1.5 text-[13px] text-muted" title="No note with this name yet">
                <span className="size-3.5 shrink-0 rounded-full border border-dashed border-muted" aria-hidden />
                <span className="truncate">{l.title}</span>
                <span className="ml-auto text-[11px]">not created</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="backlinks-h">
        <div className="mb-2 flex items-center justify-between">
          <SectionLabel>
            <span id="backlinks-h">Backlinks</span>
          </SectionLabel>
          <span className="text-[11.5px] text-muted tabular-nums">{note.backlinks.length}</span>
        </div>
        {note.backlinks.length === 0 ? (
          <p className="text-[12.5px] text-muted">No other note links here yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {note.backlinks.map((b) => (
              <li key={b.note_id}>
                <a
                  href={routeHref({ name: "note", id: b.note_id })}
                  className="block rounded-card border border-border bg-bg px-3 py-2.5 transition-colors hover:border-border-strong"
                >
                  <span className="block truncate text-[13px] font-medium text-fg">{b.title}</span>
                  {b.mentions.slice(0, 2).map(([line, text]) => (
                    <span key={line} className="mt-1 line-clamp-2 block text-[12.5px] leading-snug text-muted-strong">
                      <Mention text={text} />
                    </span>
                  ))}
                  {b.mentions.length > 2 && <span className="mt-1 block text-[11.5px] text-muted">+{plural(b.mentions.length - 2, "more mention")}</span>}
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

    </div>
  );
}

function LocalGraph({ id }: { id: string }) {
  const api = useApi();
  const lib = useLibrary();
  const [data, setData] = useState<GraphData | null>(null);
  const [depth, setDepth] = useState(1);
  useEffect(() => {
    let live = true;
    api
      .graph({ focus: id, depth })
      .then((d) => live && setData(d))
      .catch(() => live && setData({ nodes: [], edges: [], ai_edges: [] }));
    return () => {
      live = false;
    };
  }, [api, id, depth, lib.info]);
  return (
    <div className="relative h-full min-h-[300px]">
      {data && data.nodes.length <= 1 ? (
        <EmptyState icon={<Network className="size-5" />} title="No connections yet">
          Link this note to others and they'll show up here.
        </EmptyState>
      ) : (
        <GraphCanvas
          data={data}
          ordered={lib.ordered}
          focus={id}
          compact
          label="Notes connected to this one"
          onOpen={(n) => n.noteId && navigate({ name: "note", id: n.noteId })}
        />
      )}
      <div className="absolute right-3 bottom-3 left-3 flex items-center justify-between text-[11.5px] text-muted">
        <span>Double-click a note to open it</span>
        <span className="flex items-center gap-1" role="group" aria-label="Depth">
          {[1, 2, 3].map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={depth === d}
              onClick={() => setDepth(d)}
              className={cx("h-6 w-6 rounded-md border text-[11.5px]", depth === d ? "border-accent bg-accent-soft text-fg" : "border-border bg-surface hover:bg-hover")}
            >
              {d}
            </button>
          ))}
        </span>
      </div>
    </div>
  );
}

function AiConnections({ note }: { note: Note }) {
  const api = useApi();
  const toast = useToast();
  const agents = useAgentsOptional();
  const actions = useActionsOptional();
  const [items, setItems] = useState<NoteAiConnection[]>(note.ai_connections ?? []);
  useEffect(() => setItems(note.ai_connections ?? []), [note]);

  const set = async (c: NoteAiConnection, status: AiStatus) => {
    const before = items;
    setItems((xs) => (status === "dismissed" ? xs.filter((x) => x.id !== c.id) : xs.map((x) => (x.id === c.id ? { ...x, status } : x))));
    try {
      await api.aiSetStatus([c.id], status);
      agents?.bumpAi();
    } catch (e) {
      setItems(before);
      toast.show({ kind: "error", title: "Couldn't save that", description: errorMessage(e) });
    }
  };

  const groups = new Map<string, NoteAiConnection[]>();
  for (const c of items.filter((x) => x.status !== "dismissed")) groups.set(c.type, [...(groups.get(c.type) ?? []), c]);

  return (
    <section aria-labelledby="ai-h">
      <div className="mb-2 flex items-center gap-1.5">
        <Sparkles className="size-3.5 text-accent" aria-hidden />
        <SectionLabel>
          <span id="ai-h">AI connections</span>
        </SectionLabel>
        <span className="ml-auto text-[11.5px] text-muted tabular-nums">{items.length}</span>
      </div>
      {groups.size === 0 ? (
        <div className="rounded-card border border-dashed border-border px-3 py-4 text-center text-[12.5px] text-muted-strong">
          No AI connections yet.
          {actions && (
            <button type="button" className="mt-1 block w-full text-accent-text hover:underline" onClick={() => void actions.connectNote(note.path, note.title)}>
              Connect this note
            </button>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {[...groups.entries()].map(([type, cs]) => (
            <div key={type}>
              <p className="mb-1.5 text-[11.5px] font-medium text-accent-text">{typeLabel(type)}</p>
              <ul className="flex flex-col gap-2">
                {cs.map((c) => (
                  <li key={c.id} className="rounded-card border border-border bg-bg px-3 py-2.5" data-testid={`ai-${c.id}`}>
                    <div className="flex items-center gap-1.5">
                      {c.direction === "out" ? <ArrowRight className="size-3.5 shrink-0 text-accent" aria-label="to" /> : <ArrowLeft className="size-3.5 shrink-0 text-accent" aria-label="from" />}
                      <a href={routeHref({ name: "note", id: c.other_id })} className="truncate text-[13px] font-medium text-fg hover:underline">
                        {c.other_title}
                      </a>
                      {c.status === "kept" && <TypeChip>kept</TypeChip>}
                    </div>
                    <p className="mt-1 text-[12.5px] leading-snug text-muted-strong">{c.reason}</p>
                    {c.evidence.length > 0 && (
                      <details className="mt-1.5">
                        <summary className="cursor-pointer text-[12px] text-muted select-none hover:text-fg">Show quotes</summary>
                        <ul className="mt-1.5 flex flex-col gap-1.5">
                          {c.evidence.map((e, i) => (
                            <li key={i} className="border-l-2 border-accent/50 pl-2 text-[12px] leading-snug text-muted-strong">
                              “{e.quote}”
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    <div className="mt-2 flex items-center gap-1.5">
                      <Confidence value={c.confidence} />
                      <span className="truncate text-[11px] text-muted">{madeByLabel(c.made_by)}</span>
                      <span className="ml-auto flex gap-1">
                        {c.status !== "kept" && (
                          <Button size="sm" variant="secondary" onClick={() => void set(c, "kept")} aria-label={`Keep connection to ${c.other_title}`}>
                            <Check className="size-3.5" aria-hidden /> Keep
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => void set(c, "dismissed")} aria-label={`Dismiss connection to ${c.other_title}`}>
                          <X className="size-3.5" aria-hidden />
                        </Button>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
