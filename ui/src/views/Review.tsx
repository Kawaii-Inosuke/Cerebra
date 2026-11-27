import * as Tabs from "@radix-ui/react-tabs";
import { ArrowRight, Check, FileText, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AiConcept, AiConnection, AiStatus } from "../api";
import { useAgents } from "../agents";
import { useToast } from "../components/Toast";
import { Button, Confidence, Dot, EmptyState, Kbd, Spinner, TypeChip } from "../components/ui";
import { useApi, useLibrary } from "../context";
import { basenameNoExt, madeByLabel, typeLabel } from "../lib/ai";
import { colorVar } from "../lib/colors";
import { navigate, routeHref } from "../lib/router";
import { cx, errorMessage, plural } from "../lib/util";

function typingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const el = t;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || !!el.closest("[role=dialog]");
}

export function Review() {
  const api = useApi();
  const lib = useLibrary();
  const agents = useAgents();
  const toast = useToast();
  const [tab, setTab] = useState<"connections" | "concepts">("connections");
  const [collection, setCollection] = useState<string | null>(null);
  const [connections, setConnections] = useState<AiConnection[] | null>(null);
  const [concepts, setConcepts] = useState<AiConcept[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const [confirmBulk, setConfirmBulk] = useState<AiStatus | null>(null);
  const cards = useRef<(HTMLElement | null)[]>([]);

  useEffect(() => {
    let live = true;
    api
      .aiList({ status: "suggested", collection })
      .then((r) => {
        if (!live) return;
        setConnections([...r.connections].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0)));
        setConcepts(r.concepts);
        setError(null);
      })
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [api, collection, agents.aiVersion]);

  const decide = useCallback(
    async (ids: string[], status: AiStatus, label: string) => {
      setConnections((xs) => xs?.filter((c) => !ids.includes(c.id)) ?? xs);
      setConcepts((xs) => xs.filter((c) => !ids.includes(c.id)));
      try {
        await api.aiSetStatus(ids, status);
        toast.show({
          kind: "success",
          title: label,
          duration: 4000,
          action: {
            label: "Undo",
            onClick: () =>
              void api
                .aiSetStatus(ids, "suggested")
                .then(() => agents.bumpAi())
                .catch(() => {}),
          },
        });
      } catch (e) {
        toast.show({ kind: "error", title: "Couldn't save that", description: errorMessage(e) });
      }
      agents.bumpAi();
    },
    [api, agents, toast],
  );

  const list = connections ?? [];
  const current = list[Math.min(sel, list.length - 1)];

  useEffect(() => {
    if (sel >= list.length && list.length) setSel(list.length - 1);
  }, [list.length, sel]);

  useEffect(() => {
    cards.current[sel]?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  useEffect(() => {
    if (tab !== "connections") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typingTarget(e.target)) return;
      const k = e.key;
      if ((k === "j" || k === "J" || k === "ArrowDown") && list.length) {
        e.preventDefault();
        setSel((s) => Math.min(list.length - 1, s + 1));
      } else if (k === "ArrowUp" && list.length) {
        e.preventDefault();
        setSel((s) => Math.max(0, s - 1));
      } else if ((k === "k" || k === "K") && current) {
        e.preventDefault();
        void decide([current.id], "kept", `Kept: ${current.from_title} → ${current.to_title}`);
      } else if ((k === "d" || k === "D") && current) {
        e.preventDefault();
        void decide([current.id], "dismissed", `Dismissed: ${current.from_title} → ${current.to_title}`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab, list.length, current, decide]);

  const promote = async (k: AiConcept) => {
    try {
      const r = await api.aiPromoteConcept(k.id);
      setConcepts((xs) => xs.filter((c) => c.id !== k.id));
      await lib.refresh();
      agents.bumpAi();
      toast.show({
        kind: "success",
        title: `“${k.title}” is now a note`,
        description: `Saved as ${r.note_path}, with links to its notes.`,
        action: r.note_id ? { label: "Open note", onClick: () => navigate({ name: "note", id: r.note_id! }) } : undefined,
      });
    } catch (e) {
      toast.show({ kind: "error", title: "Couldn't make the note", description: errorMessage(e) });
    }
  };

  const tabClass =
    "relative h-10 px-1 text-[13px] font-medium text-muted transition-colors hover:text-fg data-[state=active]:text-fg data-[state=active]:after:absolute data-[state=active]:after:inset-x-0 data-[state=active]:after:bottom-[-1px] data-[state=active]:after:h-0.5 data-[state=active]:after:rounded-full data-[state=active]:after:bg-accent";

  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[960px] flex-col gap-5 px-8 pt-10 pb-20">
        <header className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-[24px] font-semibold tracking-[-0.02em] text-fg">Review</h1>
            <p className="mt-1 text-[13.5px] text-muted-strong">Connections and concepts your AI suggested. Keep what helps, dismiss the rest; dismissed ones are never suggested again.</p>
          </div>
          <p className="flex items-center gap-1.5 text-[12px] text-muted">
            <Kbd>K</Kbd> keep <Kbd>D</Kbd> dismiss <Kbd>J</Kbd>
            <Kbd>↑</Kbd> move
          </p>
        </header>

        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Collection filter">
          <FilterChip active={collection === null} onClick={() => setCollection(null)}>
            All
          </FilterChip>
          {lib.collections.map((c) => (
            <FilterChip key={c.name} active={collection === c.name} onClick={() => setCollection(collection === c.name ? null : c.name)}>
              <Dot color={colorVar(c.name, lib.ordered)} />
              {c.name}
            </FilterChip>
          ))}
        </div>

        <Tabs.Root value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <Tabs.List aria-label="What to review" className="flex gap-5 border-b border-border">
            <Tabs.Trigger value="connections" className={tabClass}>
              Connections {connections ? <span className="ml-1 text-muted tabular-nums">{list.length}</span> : null}
            </Tabs.Trigger>
            <Tabs.Trigger value="concepts" className={tabClass}>
              Concepts <span className="ml-1 text-muted tabular-nums">{concepts.length}</span>
            </Tabs.Trigger>
          </Tabs.List>

          <Tabs.Content value="connections" className="pt-4 outline-none">
            {error ? (
              <EmptyState title="Suggestions couldn't be loaded">{error}</EmptyState>
            ) : !connections ? (
              <div className="flex justify-center py-10">
                <Spinner />
              </div>
            ) : list.length === 0 ? (
              <div className="rounded-card border border-dashed border-border">
                <EmptyState icon={<Sparkles className="size-5" />} title="All caught up" action={<Button onClick={() => navigate({ name: "agents" })}>Open the agents</Button>}>
                  New suggestions appear here when the agents find valuable connections.
                </EmptyState>
              </div>
            ) : (
              <>
                <div className="mb-3 flex items-center gap-2">
                  <span className="text-[12.5px] text-muted">
                    {plural(list.length, "suggestion")}
                    {collection ? ` in ${collection}` : ""}
                  </span>
                  <span className="ml-auto flex gap-1.5">
                    {confirmBulk ? (
                      <>
                        <Button
                          size="sm"
                          variant={confirmBulk === "dismissed" ? "danger" : "primary"}
                          onClick={() => {
                            const st = confirmBulk;
                            setConfirmBulk(null);
                            void decide(
                              list.map((c) => c.id),
                              st,
                              `${st === "kept" ? "Kept" : "Dismissed"} ${plural(list.length, "connection")}`,
                            );
                          }}
                        >
                          {confirmBulk === "kept" ? `Keep all ${list.length}?` : `Dismiss all ${list.length}?`}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirmBulk(null)}>
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button size="sm" onClick={() => setConfirmBulk("kept")}>
                          Keep all
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirmBulk("dismissed")}>
                          Dismiss all
                        </Button>
                      </>
                    )}
                  </span>
                </div>
                <ul className="flex flex-col gap-3" aria-label="Suggested connections">
                  {list.map((c, i) => (
                    <li key={c.id} ref={(el) => void (cards.current[i] = el)}>
                      <ConnectionCard
                        c={c}
                        selected={i === sel}
                        onSelect={() => setSel(i)}
                        onKeep={() => void decide([c.id], "kept", `Kept: ${c.from_title} → ${c.to_title}`)}
                        onDismiss={() => void decide([c.id], "dismissed", `Dismissed: ${c.from_title} → ${c.to_title}`)}
                      />
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Tabs.Content>

          <Tabs.Content value="concepts" className="pt-4 outline-none">
            {concepts.length === 0 ? (
              <div className="rounded-card border border-dashed border-border">
                <EmptyState icon={<Sparkles className="size-5" />} title="No concepts to review">
                  When the same idea shows up in three or more notes, the agents suggest a concept that ties them together.
                </EmptyState>
              </div>
            ) : (
              <ul className="grid grid-cols-1 gap-3 md:grid-cols-2" aria-label="Suggested concepts">
                {concepts.map((k) => (
                  <li key={k.id} className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4">
                    <div className="flex items-center gap-2">
                      <span aria-hidden className="size-3 rounded-full border-2 border-accent" />
                      <h3 className="text-[14px] font-semibold text-fg">{k.title}</h3>
                      <span className="ml-auto flex items-center gap-1.5 text-[12px] text-muted">
                        <Dot color={colorVar(k.collection, lib.ordered)} />
                        {k.collection}
                      </span>
                    </div>
                    <p className="text-[13px] leading-relaxed text-muted-strong">{k.summary}</p>
                    <ul className="flex flex-wrap gap-1.5">
                      {k.notes.map((p) => {
                        const n = lib.notes.find((x) => x.path === p);
                        return (
                          <li key={p}>
                            <a href={n ? routeHref({ name: "note", id: n.id }) : undefined} className="inline-flex h-6 items-center gap-1 rounded-full border border-border px-2 text-[12px] text-fg hover:bg-hover">
                              <FileText className="size-3 text-muted" aria-hidden />
                              {n?.title ?? basenameNoExt(p)}
                            </a>
                          </li>
                        );
                      })}
                    </ul>
                    <p className="text-[11.5px] text-muted">{madeByLabel(k.made_by)}</p>
                    <div className="flex gap-2">
                      <Button size="sm" variant="primary" onClick={() => void promote(k)}>
                        Keep as real note
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void decide([k.id], "dismissed", `Dismissed “${k.title}”`)}>
                        Dismiss
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Tabs.Content>
        </Tabs.Root>
      </div>
    </main>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12.5px] transition-colors",
        active ? "border-border-strong bg-hover font-medium text-fg" : "border-border text-muted-strong hover:bg-hover hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

export function quotesFor(c: Pick<AiConnection, "from" | "to" | "evidence">): { from?: string; to?: string } {
  const from = c.evidence.find((e) => e.note === c.from)?.quote ?? c.evidence[0]?.quote;
  const to = c.evidence.find((e) => e.note === c.to)?.quote ?? c.evidence[1]?.quote;
  return { from, to };
}

function ConnectionCard({ c, selected, onSelect, onKeep, onDismiss }: { c: AiConnection; selected: boolean; onSelect: () => void; onKeep: () => void; onDismiss: () => void }) {
  const q = quotesFor(c);
  return (
    <article
      aria-label={`${c.from_title} ${typeLabel(c.type)} ${c.to_title}`}
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      className={cx(
        "rounded-card border bg-surface p-4 transition-[border-color,box-shadow] duration-150",
        selected ? "border-accent shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_18%,transparent)]" : "border-border hover:border-border-strong",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <a href={routeHref({ name: "note", id: c.from_id })} className="text-[14px] font-semibold text-fg hover:underline">
          {c.from_title}
        </a>
        <TypeChip>{typeLabel(c.type)}</TypeChip>
        <ArrowRight className="size-3.5 text-muted" aria-hidden />
        <a href={routeHref({ name: "note", id: c.to_id })} className="text-[14px] font-semibold text-fg hover:underline">
          {c.to_title}
        </a>
        <span className="ml-auto">
          <Confidence value={c.confidence} />
        </span>
      </div>
      <p className="mt-2 text-[13.5px] leading-relaxed text-fg">{c.reason}</p>
      <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
        <Quote title={c.from_title} text={q.from} />
        <Quote title={c.to_title} text={q.to} />
      </div>
      <div className="mt-3 flex items-center gap-2">
        <span className="text-[11.5px] text-muted">{madeByLabel(c.made_by)}</span>
        <span className="ml-auto flex gap-1.5">
          <Button size="sm" variant="primary" onClick={onKeep} aria-keyshortcuts="K">
            <Check className="size-3.5" aria-hidden /> Keep
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss} aria-keyshortcuts="D">
            <X className="size-3.5" aria-hidden /> Dismiss
          </Button>
        </span>
      </div>
    </article>
  );
}

function Quote({ title, text }: { title: string; text?: string }) {
  return (
    <figure className="rounded-input border-l-2 border-accent/50 bg-surface-2 px-3 py-2">
      <figcaption className="text-[11px] font-medium tracking-[0.02em] text-muted uppercase">{title}</figcaption>
      <blockquote className="mt-1 text-[12.5px] leading-relaxed text-muted-strong">{text ? `“${text}”` : "No quote"}</blockquote>
    </figure>
  );
}
