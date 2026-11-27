import { ArrowDown, ArrowUp, GripVertical, KeyRound, Pencil, Plus, Radar, Trash2 } from "lucide-react";
import { useState } from "react";
import type { Preset, Source, SourceStatus, SourceTest, UsageRow } from "../api";
import { useAgents } from "../agents";
import { PresetGrid, ProviderTile, SourceForm, TestResult, Testing } from "../components/AddSource";
import { useToast } from "../components/Toast";
import { Button, EmptyState, Spinner, Switch } from "../components/ui";
import { useApi } from "../context";
import { countdown, untilMs, useNow } from "../lib/ai";
import { cx, errorMessage } from "../lib/util";

export function AISources() {
  const api = useApi();
  const agents = useAgents();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [preset, setPreset] = useState<Preset | null>(null);
  const [detected, setDetected] = useState<{ ollama: string[]; lmstudio: string[] } | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);

  const list = agents.sources;
  if (list === null) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (list === false) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState icon={<KeyRound className="size-5" />} title="AI sources are set up in the desktop app">
          This window can't reach the part of Cerebra that stores keys.
        </EmptyState>
      </div>
    );
  }

  const sources = list.sources;
  const reorder = async (ids: string[]) => {
    try {
      await api.sourceReorder(ids);
    } catch (e) {
      toast.show({ kind: "error", title: "Couldn't change the order", description: errorMessage(e) });
    }
    await agents.refreshSources();
  };
  const move = (id: string, by: number) => {
    const ids = sources.map((s) => s.id);
    const i = ids.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    void reorder(ids);
  };

  const detect = async () => {
    setDetecting(true);
    try {
      setDetected(await api.detectLocalModels());
    } catch (e) {
      toast.show({ kind: "error", title: "Couldn't look for local models", description: errorMessage(e) });
    } finally {
      setDetecting(false);
    }
  };

  const addLocal = async (provider: "ollama" | "lmstudio", model: string) => {
    try {
      const s = await api.sourceAdd({ provider, model, enabled: true });
      await agents.refreshSources();
      toast.show({ kind: "success", title: `Added ${model}`, description: `${s.label} runs on this computer, so nothing leaves it.` });
    } catch (e) {
      toast.show({ kind: "error", title: `Couldn't add ${model}`, description: errorMessage(e) });
    }
  };

  const usageFor = (id: string) => list.usage.find((u) => u.source_id === id) ?? agents.usage.find((u) => u.source_id === id);

  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[860px] flex-col gap-7 px-8 pt-10 pb-20">
        <header className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-[24px] font-semibold tracking-[-0.02em] text-fg">AI sources</h1>
            <p className="mt-1 text-[13.5px] text-muted-strong">When one is busy or out of quota, the next one takes over.</p>
          </div>
          <Button onClick={() => void detect()} disabled={detecting}>
            <Radar className={cx("size-3.5", detecting && "animate-pulse")} aria-hidden /> {detecting ? "Looking…" : "Detect local models"}
          </Button>
          <Button variant="primary" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
            <Plus className="size-3.5" aria-hidden /> Add source
          </Button>
        </header>

        {!api.desktop && (
          <p className="rounded-input border border-dashed border-border px-3 py-2 text-[12.5px] text-muted-strong">
            Browser preview: these sources are pretend and nothing is sent anywhere. Keys typed here aren't stored.
          </p>
        )}

        {detected && (
          <section aria-label="Local models" className="rounded-card border border-border bg-surface p-4">
            <h2 className="text-[13px] font-semibold text-fg">On this computer</h2>
            {detected.ollama.length + detected.lmstudio.length === 0 ? (
              <p className="mt-1 text-[12.5px] text-muted-strong">No local models found. Open Ollama or LM Studio, load a model, and try again.</p>
            ) : (
              <ul className="mt-2 flex flex-col gap-1">
                {(["ollama", "lmstudio"] as const).flatMap((prov) =>
                  detected[prov].map((m) => (
                    <li key={`${prov}:${m}`} className="flex items-center gap-2 text-[13px]">
                      <span className="font-mono text-[12.5px] text-fg">{m}</span>
                      <span className="text-[12px] text-muted">{prov === "ollama" ? "Ollama" : "LM Studio"}</span>
                      {sources.some((s) => s.provider === prov && s.model === m) ? (
                        <span className="ml-auto text-[12px] text-muted">Added</span>
                      ) : (
                        <Button size="sm" className="ml-auto" onClick={() => void addLocal(prov, m)}>
                          Add
                        </Button>
                      )}
                    </li>
                  )),
                )}
              </ul>
            )}
          </section>
        )}

        {adding && (
          <section aria-label="Add a source" className="flex flex-col gap-3">
            <h2 className="text-[13px] font-semibold text-fg">Choose a provider</h2>
            <PresetGrid presets={list.presets} onPick={setPreset} selected={preset?.provider} />
            {preset && (
              <SourceForm
                key={preset.provider}
                preset={preset}
                onCancel={() => setPreset(null)}
                onDone={() => {
                  setPreset(null);
                  setAdding(false);
                  void agents.refreshSources();
                }}
              />
            )}
          </section>
        )}

        {sources.length === 0 ? (
          !adding && (
            <div className="rounded-card border border-dashed border-border">
              <EmptyState
                icon={<KeyRound className="size-5" />}
                title="No AI source yet"
                action={
                  <Button variant="primary" onClick={() => setAdding(true)}>
                    Add your first source
                  </Button>
                }
              >
                A free key from Google Gemini or Groq is enough to start. Add a second one for when the first runs out.
              </EmptyState>
            </div>
          )
        ) : (
          <section aria-label="Your sources, in the order they're tried">
            <ol className="flex flex-col gap-2">
              {sources.map((s, i) => (
                <li
                  key={s.id}
                  draggable
                  onDragStart={(e) => {
                    setDragId(s.id);
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/x-cerebra-source", s.id);
                  }}
                  onDragOver={(e) => {
                    if (dragId && dragId !== s.id) e.preventDefault();
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (!dragId || dragId === s.id) return;
                    const ids = sources.map((x) => x.id).filter((x) => x !== dragId);
                    ids.splice(ids.indexOf(s.id) + (sources.findIndex((x) => x.id === dragId) < i ? 1 : 0), 0, dragId);
                    setDragId(null);
                    void reorder(ids);
                  }}
                  onDragEnd={() => setDragId(null)}
                  className={cx(dragId === s.id && "opacity-50")}
                >
                  <SourceRow
                    source={s}
                    index={i}
                    count={sources.length}
                    status={agents.statuses[s.id] ?? list.statuses[s.id]}
                    usage={usageFor(s.id)}
                    preset={list.presets.find((p) => p.provider === s.provider)}
                    onMove={(by) => move(s.id, by)}
                  />
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>
    </main>
  );
}

export function statusText(s: Source, st: SourceStatus | undefined, now: number): { tone: "ok" | "warn" | "bad" | "muted"; text: string } {
  if (!s.enabled) return { tone: "muted", text: "Off" };
  if (!st) return { tone: "muted", text: "Not used yet" };
  const until = untilMs(st.until);
  switch (st.state) {
    case "ok":
      return { tone: "ok", text: "Ready" };
    case "cooling":
      return { tone: "warn", text: until && until > now ? `Resting ${countdown(until - now)}` : "Resting" };
    case "capped":
      return { tone: "warn", text: "Daily limit reached" };
    case "disabled":
      return { tone: "bad", text: "Key problem" };
    default:
      return { tone: "muted", text: st.state };
  }
}

const TONE: Record<string, string> = { ok: "bg-success", warn: "bg-[var(--c5)]", bad: "bg-danger", muted: "bg-muted" };

function UsageBar({ usage, source }: { usage: UsageRow | undefined; source: Source }) {
  const req = usage?.requests ?? 0;
  const tok = (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);
  const cap = source.caps.requests_per_day ?? null;
  const tcap = source.caps.tokens_per_day ?? null;
  const frac = cap ? req / cap : tcap ? tok / tcap : null;
  return (
    <div className="flex w-[200px] flex-col gap-1">
      <span className="text-[11.5px] text-muted tabular-nums">
        {req} {cap ? `of ${cap} ` : ""}requests today
        {tcap ? ` · ${Math.round(tok / 1000)}k of ${Math.round(tcap / 1000)}k tokens` : tok ? ` · ${Math.round(tok / 1000)}k tokens` : ""}
      </span>
      <div className="h-1 overflow-hidden rounded-full bg-surface-2" role={frac !== null ? "progressbar" : undefined} aria-label="Used today" aria-valuenow={frac !== null ? Math.round(frac * 100) : undefined} aria-valuemin={0} aria-valuemax={100}>
        <div className={cx("h-full rounded-full", frac !== null && frac >= 0.9 ? "bg-[var(--c5)]" : "bg-accent")} style={{ width: `${Math.min(100, Math.round((frac ?? (req ? 0.04 : 0)) * 100))}%` }} />
      </div>
    </div>
  );
}

function SourceRow({
  source: s,
  index,
  count,
  status,
  usage,
  preset,
  onMove,
}: {
  source: Source;
  index: number;
  count: number;
  status: SourceStatus | undefined;
  usage: UsageRow | undefined;
  preset: Preset | undefined;
  onMove: (by: number) => void;
}) {
  const api = useApi();
  const agents = useAgents();
  const toast = useToast();
  const now = useNow(1000);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<SourceTest | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const st = statusText(s, status, now);

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      setResult(await api.sourceTest(s.id));
    } catch (e) {
      setResult({ ok: false, latency_ms: 0, model: s.model, error: errorMessage(e) });
    } finally {
      setTesting(false);
      void agents.refreshSources();
    }
  };

  const toggle = async (enabled: boolean) => {
    try {
      await api.sourceUpdate(s.id, { provider: s.provider, model: s.model, label: s.label, base_url: s.base_url ?? undefined, caps: s.caps, enabled });
    } catch (e) {
      toast.show({ kind: "error", title: "Couldn't change it", description: errorMessage(e) });
    }
    void agents.refreshSources();
  };

  const remove = async () => {
    try {
      await api.sourceRemove(s.id);
      toast.show({ kind: "success", title: `Removed ${s.label}`, description: "Its key was deleted from the keychain." });
    } catch (e) {
      toast.show({ kind: "error", title: "Couldn't remove it", description: errorMessage(e) });
    }
    void agents.refreshSources();
  };

  return (
    <div className={cx("rounded-card border border-border bg-surface", !s.enabled && "opacity-70")} data-testid={`source-${s.id}`}>
      <div className="flex flex-wrap items-center gap-3 px-3 py-3">
        <span className="flex items-center text-muted" title="Drag to change the order">
          <GripVertical className="size-4 cursor-grab" aria-hidden />
          <span className="sr-only">Priority {index + 1}</span>
        </span>
        <span className="w-4 text-center text-[12px] text-muted tabular-nums" aria-hidden>
          {index + 1}
        </span>
        <ProviderTile provider={s.provider} label={preset?.label ?? s.label} />
        <div className="min-w-[160px] flex-1">
          <p className="flex items-center gap-1.5 text-[13.5px] font-medium text-fg">
            {s.local ? s.label.replace(/\s*\(on this computer\)/i, "") : s.label}
            {s.local && <span className="rounded-full border border-border px-1.5 text-[10.5px] font-medium text-muted">on this computer</span>}
          </p>
          <p className="truncate font-mono text-[11.5px] text-muted">{s.model}</p>
        </div>
        <span className="flex w-[120px] items-center gap-1.5 text-[12.5px] text-muted-strong" title={status?.reason || undefined}>
          <span aria-hidden className={cx("size-1.5 rounded-full", TONE[st.tone])} />
          {st.text}
        </span>
        <UsageBar usage={usage} source={s} />
        <Switch checked={s.enabled} onChange={(v) => void toggle(v)} label={`Use ${s.label}`} />
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2">
        <span className="flex items-center gap-1 text-[12px] text-muted">
          <KeyRound className="size-3" aria-hidden />
          {s.local ? "No key needed" : s.has_key ? "Key saved" : "No key yet"}
        </span>
        {status?.state === "disabled" && status.reason && <span className="text-[12px] text-danger">{status.reason}</span>}
        <span className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" aria-label="Move up" disabled={index === 0} onClick={() => onMove(-1)}>
            <ArrowUp className="size-3.5" />
          </Button>
          <Button size="sm" variant="ghost" aria-label="Move down" disabled={index === count - 1} onClick={() => onMove(1)}>
            <ArrowDown className="size-3.5" />
          </Button>
          <Button size="sm" onClick={() => void test()} disabled={testing}>
            {testing ? "Testing…" : "Test"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing((e) => !e)} aria-expanded={editing}>
            <Pencil className="size-3.5" aria-hidden /> Edit
          </Button>
          {confirmRemove ? (
            <>
              <Button size="sm" variant="danger" onClick={() => void remove()}>
                Remove {s.label}?
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" aria-label={`Remove ${s.label}`} onClick={() => setConfirmRemove(true)}>
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </span>
      </div>
      {(testing || result) && <div className="border-t border-border px-3 py-2">{testing ? <Testing /> : result && <TestResult result={result} />}</div>}
      {editing && preset && (
        <div className="border-t border-border p-3">
          <SourceForm
            preset={preset}
            source={s}
            onCancel={() => setEditing(false)}
            onDone={() => {
              setEditing(false);
              void agents.refreshSources();
            }}
          />
        </div>
      )}
    </div>
  );
}
