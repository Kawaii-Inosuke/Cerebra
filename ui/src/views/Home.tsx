import { ArrowRight, FileArchive, FileText, FolderPlus, Import, Plus, Sparkles, Upload } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { AiConnection } from "../api";
import { useAgentsOptional } from "../agents";
import { TypeChip } from "../components/ui";
import { useApi } from "../context";
import { typeLabel } from "../lib/ai";
import { useActions } from "../actions";
import { useShareOptional } from "../share";
import { DropZone } from "../components/DropZone";
import { Button, Dot, EmptyState, SectionLabel, Spinner } from "../components/ui";
import { useLibrary } from "../context";
import { colorVar } from "../lib/colors";
import { routeHref } from "../lib/router";
import { cx, plural } from "../lib/util";

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function Home() {
  const lib = useLibrary();
  const actions = useActions();
  const share = useShareOptional();

  if (lib.loading && !lib.info) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (lib.error && !lib.info) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState title="The library couldn't be loaded" action={<Button onClick={() => void lib.refresh({ reload: true })}>Try again</Button>}>
          {lib.error}
        </EmptyState>
      </div>
    );
  }

  const empty = (lib.info?.notes ?? 0) === 0;
  const recent = lib.recent.map((id) => lib.notes.find((n) => n.id === id)).filter((n) => !!n).slice(0, 6);
  const recentList = recent.length ? recent : lib.notes.slice(0, 6);

  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[960px] flex-col gap-9 px-8 pt-10 pb-20">
        <header>
          <p className="text-[12.5px] text-muted">{lib.info?.name}</p>
          <h1 className="mt-1 text-[26px] font-semibold tracking-[-0.02em] text-fg">{empty ? "Add your first material" : greeting()}</h1>
          <p className="mt-1.5 text-[14px] text-muted-strong">
            {empty
              ? "Notes, PDFs, slides and scans become linked notes you can search and explore."
              : `${plural(lib.info?.notes ?? 0, "note")} in ${plural(lib.collections.length, "collection")}, ${plural(lib.info?.files ?? 0, "file")}.`}
          </p>
        </header>

        {empty && (
          <DropZone title="Drop files to start your library" className="py-14" />
        )}

        <section aria-labelledby="qa" data-tour="add">
          <SectionLabel className="mb-3">
            <span id="qa">Quick actions</span>
          </SectionLabel>
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 xl:grid-cols-5">
            <QuickAction icon={<Upload className="size-4" />} label="Upload" hint="PDF, Word, slides, images" onClick={() => actions.chooseAndUpload()} />
            <QuickAction icon={<Plus className="size-4" />} label="New note" hint="Write in Markdown" onClick={() => void actions.newNote(null)} />
            <QuickAction icon={<Import className="size-4" />} label="Import" hint="A folder of notes" onClick={() => void actions.importVault()} />
            <QuickAction icon={<FileArchive className="size-4" />} label="Open a .cerebra file" hint="Notes someone shared" onClick={() => share?.openImport()} disabled={!share} />
            <QuickAction icon={<Sparkles className="size-4" />} label="Connect a topic" hint="Let the agents gather an idea" onClick={() => void actions.connectTopic()} ai />
          </div>
        </section>

        <section aria-labelledby="cols">
          <div className="mb-3 flex items-center justify-between">
            <SectionLabel>
              <span id="cols">Collections</span>
            </SectionLabel>
            <Button size="sm" variant="ghost" onClick={() => void actions.newCollection()}>
              <FolderPlus className="size-3.5" aria-hidden /> New collection
            </Button>
          </div>
          {lib.collections.length ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {lib.collections.map((c) => {
                const notes = lib.notes.filter((n) => n.collection === c.name);
                return (
                  <a
                    key={c.name}
                    href={routeHref({ name: "collection", collection: c.name })}
                    className="group relative flex flex-col overflow-hidden rounded-card border border-border bg-surface p-4 transition-[border-color,transform] duration-150 ease-out hover:-translate-y-px hover:border-border-strong"
                  >
                    <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ background: colorVar(c.name, lib.ordered) }} />
                    <span className="flex items-center gap-2">
                      <Dot color={colorVar(c.name, lib.ordered)} className="size-2.5" />
                      <span className="truncate text-[14px] font-semibold text-fg">{c.name}</span>
                      <ArrowRight className="ml-auto size-3.5 text-muted opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
                    </span>
                    <span className="mt-1 text-[12.5px] text-muted">{plural(c.notes, "note")}</span>
                    <span className="mt-3 flex flex-col gap-1">
                      {notes.slice(0, 3).map((n) => (
                        <span key={n.id} className="truncate text-[12.5px] text-muted-strong">
                          {n.title}
                        </span>
                      ))}
                      {!notes.length && <span className="text-[12.5px] text-muted">Empty. Drop files here to fill it.</span>}
                    </span>
                  </a>
                );
              })}
            </div>
          ) : (
            <div className="rounded-card border border-dashed border-border">
              <EmptyState title="No collections yet" action={<Button onClick={() => void actions.newCollection()}>Create a collection</Button>}>
                Make one per subject, course or project, like Biology or Physics.
              </EmptyState>
            </div>
          )}
        </section>

        {!empty && <RecentlyConnected />}

        {!empty && (
          <section aria-labelledby="recent">
            <SectionLabel className="mb-3">
              <span id="recent">{recent.length ? "Recently opened" : "Notes"}</span>
            </SectionLabel>
            <ul className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface">
              {recentList.map((n) => (
                <li key={n.id}>
                  <a href={routeHref({ name: "note", id: n.id })} className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-hover">
                    <FileText className="size-4 shrink-0 text-muted" aria-hidden />
                    <span className="truncate text-[13.5px] text-fg">{n.title}</span>
                    <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[12px] text-muted">
                      <Dot color={colorVar(n.collection, lib.ordered)} />
                      {n.collection ?? "Inbox"}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}

function QuickAction({ icon, label, hint, onClick, disabled, ai }: { icon: ReactNode; label: string; hint: string; onClick?: () => void; disabled?: boolean; ai?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? hint : undefined}
      className={cx(
        "flex flex-col items-start gap-2 rounded-card border border-border bg-surface p-3.5 text-left transition-[border-color,background] duration-150 ease-out",
        disabled ? "opacity-60" : "hover:border-border-strong hover:bg-surface-2",
      )}
    >
      <span className={cx("flex size-7 items-center justify-center rounded-input", ai ? "bg-accent-soft text-accent-text" : "bg-surface-2 text-muted-strong")}>{icon}</span>
      <span>
        <span className="block text-[13px] font-medium text-fg">{label}</span>
        <span className="block text-[12px] text-muted">{hint}</span>
      </span>
    </button>
  );
}

function RecentlyConnected() {
  const api = useApi();
  const agents = useAgentsOptional();
  const [items, setItems] = useState<AiConnection[] | null>(null);
  useEffect(() => {
    let live = true;
    api
      .aiList()
      .then((r) => {
        if (!live) return;
        const xs = r.connections.filter((c) => c.status !== "dismissed").sort((a, b) => b.created_at.localeCompare(a.created_at));
        setItems(xs.slice(0, 6));
      })
      .catch(() => live && setItems([]));
    return () => {
      live = false;
    };
  }, [api, agents?.aiVersion]);
  if (!items) return null;
  return (
    <section aria-labelledby="rc">
      <div className="mb-3 flex items-center justify-between">
        <SectionLabel>
          <span id="rc">Recently connected</span>
        </SectionLabel>
        {agents && agents.suggested > 0 && (
          <a href={routeHref({ name: "review" })} className="text-[12.5px] font-medium text-accent-text hover:underline">
            Review {plural(agents.suggested, "suggestion")}
          </a>
        )}
      </div>
      {items.length === 0 ? (
        <div className="rounded-card border border-dashed border-border px-4 py-5 text-[13px] text-muted-strong">
          No AI connections yet. Add an AI source and the agents will start linking ideas across your notes.{" "}
          <a href={routeHref({ name: "ai-sources" })} className="font-medium text-accent-text hover:underline">
            Add an AI source
          </a>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
          {items.map((c) => (
            <li key={c.id}>
              <a href={routeHref({ name: "note", id: c.from_id })} className="flex h-full flex-col gap-1.5 rounded-card border border-border bg-surface px-3.5 py-3 transition-colors hover:border-border-strong">
                <span className="flex min-w-0 items-center gap-1.5 text-[13px]">
                  <span className="truncate font-medium text-fg">{c.from_title}</span>
                  <TypeChip>{typeLabel(c.type)}</TypeChip>
                  <span className="truncate font-medium text-fg">{c.to_title}</span>
                  {c.status === "suggested" && <span className="ml-auto shrink-0 text-[11px] text-muted">to review</span>}
                </span>
                <span className="line-clamp-2 text-[12.5px] leading-snug text-muted-strong">“{c.reason}”</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
