import * as Dialog from "@radix-ui/react-dialog";
import { Bot, CircleAlert, Pause, Play, ShieldCheck, Sparkles, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { AgentsSettings, Job } from "../api";
import { useAgents } from "../agents";
import { useToast } from "../components/Toast";
import { Button, EmptyState, SectionLabel, Spinner, Switch } from "../components/ui";
import { useApi, useLibrary } from "../context";
import { computePill, friendlyError, jobKindLabel, jobTitle, STAGES, stageIndex, useNow } from "../lib/ai";
import { colorVar } from "../lib/colors";
import { navigate } from "../lib/router";
import { cx, errorMessage, plural } from "../lib/util";

/** Rough model calls per note for one connect pass (doc 06 §3: reader, linker, judge…). */
export const CALLS_PER_NOTE = 4;

export function Agents() {
  const api = useApi();
  const agents = useAgents();
  const lib = useLibrary();
  const toast = useToast();
  const now = useNow(5000);
  const [estimateOpen, setEstimateOpen] = useState(false);
  const settings = agents.settings;
  const pill = computePill({ sources: agents.sources, settings, jobs: agents.jobs, progress: agents.progress, statuses: agents.statuses, now });
  const enabledSources = agents.sources ? agents.sources.sources.filter((s) => s.enabled) : [];

  const groups = useMemo(() => {
    const running = agents.jobs.filter((j) => j.status === "running");
    const waiting = agents.jobs.filter((j) => j.status === "queued" || j.status === "paused");
    const recent = agents.jobs.filter((j) => !["running", "queued", "paused"].includes(j.status)).slice(0, 20);
    return { running, waiting, recent };
  }, [agents.jobs]);

  const cancel = async (j: Job) => {
    try {
      await api.jobCancel(j.id);
      toast.show({ title: `Cancelled ${jobTitle(j)}`, duration: 2500 });
    } catch (e) {
      toast.show({ kind: "error", title: "Couldn't cancel it", description: errorMessage(e) });
    }
    void agents.refreshJobs();
  };

  const connectEverything = async () => {
    setEstimateOpen(false);
    let n = 0;
    for (const c of lib.collections) {
      try {
        await api.jobEnqueue("connect_collection", c.name);
        n++;
      } catch (e) {
        toast.show({ kind: "error", title: `Couldn't queue ${c.name}`, description: errorMessage(e) });
      }
    }
    if (n) toast.show({ kind: "success", title: `Queued ${plural(n, "collection")}`, description: "Notes that haven't changed since they were last connected are skipped." });
    void agents.refreshJobs();
  };

  const notes = lib.collections.reduce((a, c) => a + c.notes, 0);

  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[860px] flex-col gap-7 px-8 pt-10 pb-20">
        <header className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-[24px] font-semibold tracking-[-0.02em] text-fg">Agents</h1>
            <p className="mt-1 flex items-center gap-1.5 text-[13.5px] text-muted-strong">
              <span aria-hidden className={cx("size-1.5 rounded-full", pill.kind === "connecting" ? "animate-pulse bg-accent" : pill.kind === "idle" ? "bg-success" : "bg-muted")} />
              {pill.label}
              {pill.kind === "none" && (
                <button type="button" className="ml-1 text-accent-text hover:underline" onClick={() => navigate({ name: "ai-sources" })}>
                  Add an AI source
                </button>
              )}
            </p>
          </div>
          {settings &&
            (settings.paused ? (
              <Button onClick={() => void agents.saveSettings({ paused: false })}>
                <Play className="size-3.5" aria-hidden /> Resume
              </Button>
            ) : (
              <Button onClick={() => void agents.saveSettings({ paused: true })}>
                <Pause className="size-3.5" aria-hidden /> Pause all
              </Button>
            ))}
          <Button variant="primary" onClick={() => setEstimateOpen(true)} disabled={!lib.collections.length}>
            <Sparkles className="size-3.5" aria-hidden /> Connect everything
          </Button>
        </header>

        {settings?.paused && (
          <p className="rounded-input border border-border bg-surface-2 px-3 py-2 text-[12.5px] text-muted-strong">Paused. Jobs stay in the queue until you resume.</p>
        )}

        <section aria-labelledby="queue-h" className="flex flex-col gap-3">
          <SectionLabel>
            <span id="queue-h">Queue</span>
          </SectionLabel>
          {agents.jobs.length === 0 ? (
            <div className="rounded-card border border-dashed border-border">
              <EmptyState icon={<Bot className="size-5" />} title="Nothing to do right now">
                New and changed notes are connected automatically. You can also connect a note from its page, or everything at once.
              </EmptyState>
            </div>
          ) : (
            <>
              {[...groups.running, ...groups.waiting].length > 0 && (
                <ul className="flex flex-col gap-2" aria-label="Running and waiting">
                  {[...groups.running, ...groups.waiting].map((j) => (
                    <li key={j.id}>
                      <JobCard job={j} live={agents.progress[j.id]} onCancel={() => void cancel(j)} />
                    </li>
                  ))}
                </ul>
              )}
              {groups.recent.length > 0 && (
                <ul className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface" aria-label="Recent jobs">
                  {groups.recent.map((j) => (
                    <li key={j.id}>
                      <RecentJob job={j} />
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>

        <section aria-labelledby="activity-h" className="flex flex-col gap-3">
          <SectionLabel>
            <span id="activity-h">Activity today</span>
          </SectionLabel>
          {agents.usage.length === 0 ? (
            <p className="text-[12.5px] text-muted">No model calls yet today. Only passages of the notes being connected are sent, to the sources you turned on.</p>
          ) : (
            <table className="w-full overflow-hidden rounded-card border border-border bg-surface text-left text-[12.5px]">
              <thead className="bg-surface-2 text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Source</th>
                  <th className="px-3 py-2 text-right font-medium">Calls</th>
                  <th className="px-3 py-2 text-right font-medium">Tokens sent</th>
                  <th className="px-3 py-2 text-right font-medium">Tokens received</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {agents.usage.map((u) => {
                  const s = agents.sources ? agents.sources.sources.find((x) => x.id === u.source_id) : undefined;
                  return (
                    <tr key={u.source_id}>
                      <td className="px-3 py-2 text-fg">{s?.label ?? u.source_id}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{u.requests}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{u.input_tokens.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{u.output_tokens.toLocaleString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        {settings ? <SettingsCard settings={settings} /> : agents.sources === false ? null : <Spinner />}
      </div>

      <Dialog.Root open={estimateOpen} onOpenChange={setEstimateOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="anim-fade fixed inset-0 z-50 bg-[var(--overlay)]" />
          <Dialog.Content className="anim-pop fixed top-[22%] left-1/2 z-50 w-[440px] max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-card border border-border bg-surface p-5 shadow-pop">
            <Dialog.Title className="text-[15px] font-semibold text-fg">Connect everything?</Dialog.Title>
            <Dialog.Description className="mt-2 text-[13px] leading-relaxed text-muted-strong">
              {plural(lib.collections.length, "collection")} with {plural(notes, "note")}. That's about {(notes * CALLS_PER_NOTE).toLocaleString()} AI calls ({CALLS_PER_NOTE} per note), spread over{" "}
              {enabledSources.length ? plural(enabledSources.length, "source") : "your sources"}. Notes that haven't changed since they were last connected are skipped, and free sources rest
              when they hit their limits, so this can take a while.
            </Dialog.Description>
            {!enabledSources.length && <p className="mt-3 text-[12.5px] text-danger">No AI source is turned on yet, so the jobs will wait until you add one.</p>}
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setEstimateOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => void connectEverything()}>
                Queue {plural(lib.collections.length, "collection")}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </main>
  );
}

export function StageChips({ stage }: { stage: string | undefined }) {
  const at = stageIndex(stage);
  return (
    <ol className="flex flex-wrap items-center gap-1" aria-label="Stages">
      {STAGES.map((s, i) => (
        <li
          key={s.key}
          aria-current={i === at ? "step" : undefined}
          className={cx(
            "rounded-full px-2 py-px text-[11px] font-medium",
            i === at ? "bg-accent text-accent-fg" : i < at ? "bg-accent-soft text-accent-text" : "bg-surface-2 text-muted",
          )}
        >
          {s.label}
        </li>
      ))}
    </ol>
  );
}

function JobCard({ job, live, onCancel }: { job: Job; live: Job["progress"] | undefined; onCancel: () => void }) {
  const p = { ...(job.progress ?? {}), ...(live ?? {}) };
  const running = job.status === "running";
  const frac = p.total ? Math.min(1, (p.done ?? 0) / p.total) : null;
  return (
    <div className="rounded-card border border-border bg-surface p-3.5" data-testid={`job-${job.id}`}>
      <div className="flex items-center gap-2">
        <span className="rounded-full border border-border px-1.5 text-[10.5px] font-medium text-muted">{jobKindLabel(job.kind)}</span>
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-fg">{jobTitle(job)}</span>
        <span className="text-[12px] text-muted">{running ? (p.total ? `${p.done ?? 0} of ${p.total}` : "Starting…") : job.status === "paused" ? "Paused" : "Waiting"}</span>
        <Button size="sm" variant="ghost" onClick={onCancel} aria-label={`Cancel ${jobTitle(job)}`}>
          <X className="size-3.5" />
        </Button>
      </div>
      {running && (
        <div className="mt-2.5 flex flex-col gap-2">
          <StageChips stage={p.stage} />
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-label="Progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={frac === null ? undefined : Math.round(frac * 100)}>
            <div className={cx("h-full rounded-full bg-accent transition-[width] duration-200 ease-out", frac === null && "w-1/3 animate-pulse")} style={frac === null ? undefined : { width: `${Math.round(frac * 100)}%` }} />
          </div>
          {p.message && <p className="truncate text-[12px] text-muted">{p.message}</p>}
        </div>
      )}
    </div>
  );
}

function RecentJob({ job }: { job: Job }) {
  const failed = job.status === "failed";
  return (
    <div className="flex items-start gap-2 px-3.5 py-2.5 text-[13px]">
      <span className="mt-0.5 rounded-full border border-border px-1.5 text-[10.5px] font-medium text-muted">{jobKindLabel(job.kind)}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-fg">{jobTitle(job)}</p>
        {failed && (
          <p className="mt-0.5 flex items-start gap-1 text-[12.5px] text-danger">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {friendlyError(job.error)}
          </p>
        )}
      </div>
      <span className={cx("text-[12px]", failed ? "text-danger" : job.status === "done" ? "text-success" : "text-muted")}>
        {job.status === "done" ? "Done" : failed ? "Failed" : job.status === "cancelled" ? "Cancelled" : job.status}
      </span>
    </div>
  );
}

function Row({ label, description, children }: { label: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-6 px-4 py-3.5">
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-medium text-fg">{label}</p>
        {description && <div className="mt-0.5 text-[12.5px] text-muted">{description}</div>}
      </div>
      <div className="flex shrink-0 justify-end">{children}</div>
    </div>
  );
}

function SettingsCard({ settings }: { settings: AgentsSettings }) {
  const agents = useAgents();
  const lib = useLibrary();
  const [budget, setBudget] = useState(String(settings.budget));
  const toggleLocal = (name: string) => {
    const has = settings.local_only.includes(name);
    void agents.saveSettings({ local_only: has ? settings.local_only.filter((x) => x !== name) : [...settings.local_only, name] });
  };
  const thresholds: { v: AgentsSettings["threshold"]; label: string }[] = [
    { v: "strict", label: "Strict" },
    { v: "balanced", label: "Balanced" },
    { v: "generous", label: "Generous" },
  ];
  return (
    <section aria-labelledby="agent-settings-h">
      <h2 id="agent-settings-h" className="mb-2 text-[13px] font-semibold text-fg">
        Settings
      </h2>
      <div className="divide-y divide-border rounded-card border border-border bg-surface">
        <Row label="Auto-connect" description="Connect new and changed notes on their own, shortly after you save them.">
          <Switch checked={settings.auto_connect} onChange={(v) => void agents.saveSettings({ auto_connect: v })} label="Auto-connect" />
        </Row>
        <Row label="How picky" description="Strict keeps only the strongest connections; Generous keeps more.">
          <div role="radiogroup" aria-label="How picky" className="inline-flex gap-0.5 rounded-input border border-border bg-surface-2 p-0.5">
            {thresholds.map((t) => (
              <button
                key={t.v}
                type="button"
                role="radio"
                aria-checked={settings.threshold === t.v}
                onClick={() => void agents.saveSettings({ threshold: t.v })}
                className={cx("h-7 rounded-[6px] px-2.5 text-[12.5px]", settings.threshold === t.v ? "bg-surface font-medium text-fg ring-1 ring-border" : "text-muted-strong hover:text-fg")}
              >
                {t.label}
              </button>
            ))}
          </div>
        </Row>
        <Row label="Trust the agents" description="Save new connections as kept straight away, instead of asking you in Review.">
          <Switch checked={settings.trust} onChange={(v) => void agents.saveSettings({ trust: v })} label="Trust the agents" />
        </Row>
        <Row label="Budget per job" description="The most AI calls one job may use (5–200).">
          <input
            aria-label="Budget per job"
            inputMode="numeric"
            value={budget}
            onChange={(e) => setBudget(e.target.value.replace(/\D/g, ""))}
            onBlur={() => {
              const n = Math.min(200, Math.max(5, Number(budget) || settings.budget));
              setBudget(String(n));
              if (n !== settings.budget) void agents.saveSettings({ budget: n });
            }}
            className="h-8 w-20 rounded-input border border-border bg-bg px-2.5 text-right text-[13px] tabular-nums outline-none focus:border-accent"
          />
        </Row>
        <div className="px-4 py-3.5">
          <p className="flex items-center gap-1.5 text-[13.5px] font-medium text-fg">
            <ShieldCheck className="size-4 text-muted-strong" aria-hidden /> Local-only collections
          </p>
          <p className="mt-0.5 text-[12.5px] text-muted">
            Notes in these collections are only sent to AI running on this computer (Ollama, LM Studio). If none is set up, their jobs wait. AI apps connected to Cerebra can still read them, because you
            chose to ask about them there.
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Local-only collections">
            {lib.collections.map((c) => {
              const on = settings.local_only.includes(c.name);
              return (
                <button
                  key={c.name}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleLocal(c.name)}
                  className={cx(
                    "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12.5px] transition-colors",
                    on ? "border-accent bg-accent-soft font-medium text-fg" : "border-border text-muted-strong hover:bg-hover",
                  )}
                >
                  <span aria-hidden className="size-2 rounded-full" style={{ background: colorVar(c.name, lib.ordered) }} />
                  {c.name}
                  {on && <ShieldCheck className="size-3 text-accent-text" aria-hidden />}
                </button>
              );
            })}
            {!lib.collections.length && <span className="text-[12.5px] text-muted">No collections yet.</span>}
          </div>
        </div>
      </div>
    </section>
  );
}
