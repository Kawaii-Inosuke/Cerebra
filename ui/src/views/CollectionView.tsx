import { FileText, Network, Plus, Search, Share2, Upload } from "lucide-react";
import { useShareOptional } from "../share";
import { useMemo, useState } from "react";
import { useActions } from "../actions";
import { DropZone } from "../components/DropZone";
import { PanelHeader, RightPanel } from "../components/RightPanel";
import { Button, Dot, EmptyState, SectionLabel, TagChip } from "../components/ui";
import { useLibrary } from "../context";
import { colorVar } from "../lib/colors";
import { navigate, routeHref } from "../lib/router";
import { plural } from "../lib/util";

export function CollectionView({ collection }: { collection: string | null }) {
  const lib = useLibrary();
  const actions = useActions();
  const share = useShareOptional();
  const [filter, setFilter] = useState("");
  const name = collection ?? "Inbox";
  const notes = useMemo(() => lib.notes.filter((n) => n.collection === collection).sort((a, b) => a.title.localeCompare(b.title)), [lib.notes, collection]);
  const shown = filter.trim() ? notes.filter((n) => n.title.toLowerCase().includes(filter.trim().toLowerCase())) : notes;
  const exists = collection === null || lib.collections.some((c) => c.name === collection);
  const tags = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of notes) for (const t of n.tags) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  }, [notes]);

  if (!exists && !lib.loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState title={`There's no collection called “${name}”`} action={<Button onClick={() => navigate({ name: "home" })}>Go home</Button>}>
          It may have been renamed or removed.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[860px] flex-col gap-7 px-8 pt-10 pb-20">
          <header className="flex flex-wrap items-end gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2.5">
                <Dot color={colorVar(collection, lib.ordered)} className="size-3" />
                <h1 className="truncate text-[24px] font-semibold tracking-[-0.02em] text-fg">{name}</h1>
              </div>
              <p className="mt-1 text-[13.5px] text-muted-strong">
                {collection === null ? "Notes at the top of your library, outside any collection." : plural(notes.length, "note")}
              </p>
            </div>
            {collection !== null && share && (
              <Button variant="ghost" onClick={() => share.openExport(collection)}>
                <Share2 className="size-3.5" aria-hidden /> Share as file…
              </Button>
            )}
            <Button onClick={() => actions.chooseAndUpload(collection)} disabled={collection === null}>
              <Upload className="size-3.5" aria-hidden /> Upload
            </Button>
            <Button variant="primary" onClick={() => void actions.newNote(collection)}>
              <Plus className="size-3.5" aria-hidden /> New note
            </Button>
          </header>

          {notes.length === 0 ? (
            collection !== null ? (
              <DropZone collection={collection} title={`Add material to ${name}`} />
            ) : (
              <EmptyState title="Nothing here">Notes you create outside a collection appear here.</EmptyState>
            )
          ) : (
            <section aria-label="Notes">
              {notes.length > 8 && (
                <label className="mb-3 flex h-8 items-center gap-2 rounded-input border border-border bg-surface px-2.5 focus-within:border-accent">
                  <Search className="size-3.5 text-muted" aria-hidden />
                  <span className="sr-only">Filter notes</span>
                  <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Filter ${plural(notes.length, "note")}…`} className="flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted" />
                </label>
              )}
              <ul className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface">
                {shown.map((n) => (
                  <li key={n.id}>
                    <a href={routeHref({ name: "note", id: n.id })} className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-hover">
                      <FileText className="size-4 shrink-0 text-muted" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13.5px] text-fg">{n.title}</span>
                        {n.path.split("/").length > 2 && <span className="block truncate text-[11.5px] text-muted">{n.path.split("/").slice(1, -1).join(" / ")}</span>}
                      </span>
                      <span className="flex shrink-0 gap-1">
                        {n.tags.slice(0, 2).map((t) => (
                          <TagChip key={t} tag={t} />
                        ))}
                      </span>
                    </a>
                  </li>
                ))}
                {!shown.length && <li className="px-4 py-6 text-center text-[13px] text-muted">No note titles match “{filter}”.</li>}
              </ul>
              {collection !== null && (
                <DropZone collection={collection} title={`Drop more files into ${name}`} className="mt-4 py-6">
                  Or click to choose files.
                </DropZone>
              )}
            </section>
          )}
        </div>
      </main>
      <RightPanel label="Collection details">
        <PanelHeader>About this collection</PanelHeader>
        <div className="flex flex-col gap-6 overflow-y-auto p-4">
          <dl className="grid grid-cols-2 gap-2">
            <Stat label="Notes" value={notes.length} />
            <Stat label="Tags" value={tags.length} />
          </dl>
          {collection !== null && (
            <Button onClick={() => navigate({ name: "graph", collection: collection ?? undefined })} className="w-full">
              <Network className="size-3.5" aria-hidden /> See it in the graph
            </Button>
          )}
          <section>
            <SectionLabel className="mb-2">Top tags</SectionLabel>
            {tags.length ? (
              <div className="flex flex-wrap gap-1.5">
                {tags.map(([t]) => (
                  <TagChip key={t} tag={t} />
                ))}
              </div>
            ) : (
              <p className="text-[12.5px] text-muted">No tags yet. Add #tags to notes to group ideas.</p>
            )}
          </section>
        </div>
      </RightPanel>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-card border border-border bg-bg px-3 py-2.5">
      <dt className="text-[11.5px] text-muted">{label}</dt>
      <dd className="text-[18px] font-semibold text-fg tabular-nums">{value}</dd>
    </div>
  );
}
