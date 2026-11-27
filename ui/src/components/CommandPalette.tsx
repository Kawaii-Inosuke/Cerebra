import { Command } from "cmdk";
import { Bot, Compass, FileArchive, Info, FileText, FolderPlus, Import, Inbox, KeyRound, Moon, Network, Plug, Plus, Search, Settings, Share2, Sparkles, TextQuote, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SearchHit } from "../api";
import { useActions } from "../actions";
import { useApi, useLibrary, useShell } from "../context";
import { useShareOptional } from "../share";
import { useAbout } from "./About";
import { useTour } from "./Tour";
import { colorVar } from "../lib/colors";
import { snippetParts } from "../lib/links";
import { navigate, useRoute } from "../lib/router";
import { modKey } from "../lib/util";
import { Dot, Kbd } from "./ui";

interface Cmd {
  id: string;
  label: string;
  icon: ReactNode;
  shortcut?: string[];
  /** Refine the search instead of closing (e.g. pick a collection next). */
  refine?: string;
  run(): void;
}

function matches(text: string, q: string): boolean {
  const t = text.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => t.includes(w));
}

export function CommandPalette() {
  const api = useApi();
  const lib = useLibrary();
  const actions = useActions();
  const { paletteOpen: open, setPaletteOpen: setOpen } = useShell();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const seq = useRef(0);

  // Ctrl/Cmd+K anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setHits([]);
    }
  }, [open]);

  // Passages: debounced full-text search.
  useEffect(() => {
    const q = query.trim();
    const my = ++seq.current;
    if (q.length < 2) {
      setHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      api
        .search(q, { limit: 8 })
        .then((r) => my === seq.current && setHits(r))
        .catch(() => my === seq.current && setHits([]))
        .finally(() => my === seq.current && setSearching(false));
    }, 120);
    return () => clearTimeout(t);
  }, [api, query]);

  const close = () => setOpen(false);
  const run = (f: () => void) => {
    close();
    // Let the dialog close (and give focus back) before the action opens its own.
    setTimeout(f, 0);
  };

  const route = useRoute();
  const share = useShareOptional();
  const about = useAbout();
  const tour = useTour();
  const noteHere = route.name === "note" ? lib.notes.find((n) => n.id === route.id) : undefined;

  const commands: Cmd[] = useMemo(
    () => [
      { id: "upload", label: "Upload files", icon: <Upload className="size-4" />, run: () => actions.chooseAndUpload() },
      { id: "new-note", label: "New note", icon: <Plus className="size-4" />, run: () => void actions.newNote() },
      { id: "new-collection", label: "New collection", icon: <FolderPlus className="size-4" />, run: () => void actions.newCollection() },
      { id: "import", label: "Import a folder of notes", icon: <Import className="size-4" />, run: () => void actions.importVault() },
      ...(noteHere ? [{ id: "connect-note", label: `Connect this note (${noteHere.title})`, icon: <Sparkles className="size-4 text-accent" />, run: () => void actions.connectNote(noteHere.path, noteHere.title) }] : []),
      ...lib.collections.map((c) => ({ id: `connect-c-${c.name}`, label: `Connect collection: ${c.name}`, icon: <Sparkles className="size-4 text-accent" />, run: () => void actions.connectCollection(c.name) })),
      ...(lib.collections.length ? [{ id: "connect-collection", label: "Connect collection…", icon: <Sparkles className="size-4 text-accent" />, refine: "connect collection ", run: () => {} }] : []),
      ...(share && lib.collections.length ? [{ id: "share-collection", label: "Share collection…", icon: <Share2 className="size-4" />, refine: "share collection ", run: () => {} }] : []),
      ...(share ? lib.collections.map((c) => ({ id: `share-c-${c.name}`, label: `Share collection: ${c.name}`, icon: <Share2 className="size-4" />, run: () => share.openExport(c.name) })) : []),
      ...(share ? [{ id: "open-share", label: "Open a .cerebra file", icon: <FileArchive className="size-4" />, run: () => share.openImport() }] : []),
      { id: "connect-ai", label: "Connect your AI", icon: <Plug className="size-4" />, run: () => navigate({ name: "connect-ai" }) },
      { id: "connect-topic", label: "Connect a topic…", icon: <Sparkles className="size-4 text-accent" />, run: () => void actions.connectTopic() },
      { id: "review", label: "Open review", icon: <Inbox className="size-4" />, run: () => navigate({ name: "review" }) },
      { id: "agents", label: "Open agents", icon: <Bot className="size-4" />, run: () => navigate({ name: "agents" }) },
      { id: "add-source", label: "Add AI source", icon: <KeyRound className="size-4" />, run: () => navigate({ name: "ai-sources" }) },
      { id: "graph", label: "Go to graph", icon: <Network className="size-4" />, run: actions.openGraph },
      { id: "theme", label: "Toggle theme", icon: <Moon className="size-4" />, run: actions.toggleTheme },
      { id: "settings", label: "Open settings", icon: <Settings className="size-4" />, shortcut: [modKey, ","], run: actions.openSettings },
      ...(tour ? [{ id: "tour", label: "Take the tour", icon: <Compass className="size-4" />, run: () => tour.start() }] : []),
      ...(about ? [{ id: "about", label: "About Cerebra", icon: <Info className="size-4" />, run: () => about.open() }] : []),
    ],
    [actions, lib.collections, noteHere, share, tour, about],
  );

  const q = query.trim();
  const noteResults = useMemo(() => {
    const list = q ? lib.notes.filter((n) => matches(`${n.title} ${n.collection ?? ""}`, q)) : lib.notes.filter((n) => lib.recent.includes(n.id));
    return list.slice(0, q ? 8 : 5);
  }, [lib.notes, lib.recent, q]);
  const cmdResults = q
    ? commands.filter((c) => matches(c.label, q) && !(c.refine && q.toLowerCase().startsWith(c.refine.trim())))
    : commands.filter((c) => !c.id.startsWith("connect-c-") && !c.id.startsWith("share-c-"));
  const passageResults = hits.filter((h) => h.snippet.trim());

  const openNote = (id: string, sub?: string) => run(() => navigate(sub ? { name: "note", id, sub } : { name: "note", id }));

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Command palette"
      shouldFilter={false}
      loop
      overlayClassName="anim-fade fixed inset-0 z-50 bg-[var(--overlay)]"
      contentClassName="anim-pop fixed top-[14vh] left-1/2 z-50 w-[640px] max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-hidden rounded-[12px] border border-border bg-surface shadow-pop"
    >
      <div className="flex items-center gap-2.5 border-b border-border px-4">
        <Search className="size-4 shrink-0 text-muted" aria-hidden />
        <Command.Input
          value={query}
          onValueChange={setQuery}
          placeholder="Search notes and passages, or type a command…"
          className="h-12 flex-1 bg-transparent text-[14.5px] text-fg outline-none placeholder:text-muted"
        />
        {searching && <span className="size-3.5 animate-spin rounded-full border-2 border-border border-t-accent" aria-label="Searching" />}
        <Kbd>Esc</Kbd>
      </div>
      <Command.List className="max-h-[min(440px,60vh)] overflow-y-auto p-1.5">
        <Command.Empty className="px-3 py-8 text-center text-[13px] text-muted">
          {searching ? "Searching…" : `Nothing found for “${q}”. Try other words, or create a note with this title.`}
        </Command.Empty>

        {noteResults.length > 0 && (
          <Command.Group heading={q ? "Notes" : "Recent notes"}>
            {noteResults.map((n) => (
              <Item key={n.id} value={`note:${n.id}`} onSelect={() => openNote(n.id)}>
                <FileText className="size-4 shrink-0 text-muted" aria-hidden />
                <span className="truncate text-fg">{n.title}</span>
                <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[12px] text-muted">
                  <Dot color={colorVar(n.collection, lib.ordered)} />
                  {n.collection ?? "Inbox"}
                </span>
              </Item>
            ))}
          </Command.Group>
        )}

        {passageResults.length > 0 && (
          <Command.Group heading="Passages">
            {passageResults.map((h, i) => (
              <Item key={`${h.note_id}:${h.line}:${i}`} value={`passage:${h.note_id}:${h.line}:${i}`} onSelect={() => openNote(h.note_id, subFor(h.heading_path, h.title))}>
                <TextQuote className="mt-0.5 size-4 shrink-0 self-start text-muted" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-[12.5px] text-muted">
                    <span className="truncate font-medium text-fg">{h.title}</span>
                    {h.heading_path && h.heading_path !== h.title && <span className="truncate">› {splitPath(h.heading_path).filter((x) => x !== h.title).join(" › ")}</span>}
                  </span>
                  <span className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-muted-strong">
                    {snippetParts(cleanSnippet(h.snippet)).map((p, j) =>
                      p.hit ? (
                        <mark key={j} className="rounded-[3px] bg-accent-soft px-0.5 text-fg">
                          {p.text}
                        </mark>
                      ) : (
                        <span key={j}>{p.text}</span>
                      ),
                    )}
                  </span>
                </span>
              </Item>
            ))}
          </Command.Group>
        )}

        {cmdResults.length > 0 && (
          <Command.Group heading="Commands">
            {cmdResults.map((c) => (
              <Item key={c.id} value={`cmd:${c.id}`} onSelect={() => (c.refine ? setQuery(c.refine) : run(c.run))}>
                <span className="text-muted">{c.icon}</span>
                <span className="text-fg">{c.label}</span>
                {c.shortcut && (
                  <span className="ml-auto flex gap-1">
                    {c.shortcut.map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </span>
                )}
              </Item>
            ))}
          </Command.Group>
        )}
      </Command.List>
      <div className="flex items-center gap-4 border-t border-border bg-surface-2 px-4 py-2 text-[11.5px] text-muted">
        <span className="flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> move
        </span>
        <span className="flex items-center gap-1">
          <Kbd>↵</Kbd> open
        </span>
      </div>
    </Command.Dialog>
  );
}

function Item({ value, onSelect, children }: { value: string; onSelect: () => void; children: ReactNode }) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-2.5 rounded-input px-2.5 py-2 text-[13px] transition-colors duration-100"
    >
      {children}
    </Command.Item>
  );
}

/** The heading to scroll to for a passage (none when it's the note's own title). */
function subFor(headingPath: string, title: string): string | undefined {
  const last = splitPath(headingPath).pop();
  return last && last !== title ? last : undefined;
}

/** `[[Target|label]]` → `label`, `[[Target#Sub]]` → `Target`, for readable snippets. */
export function cleanSnippet(s: string): string {
  return s.replace(/\[\[([^\]|]*?)(?:\|([^\]]*))?\]\]/g, (_m, target: string, label?: string) => label ?? target.split("#")[0] ?? target);
}

function splitPath(p: string): string[] {
  return p.split(/\s+[›>]\s+/).map((x) => x.trim()).filter(Boolean);
}
