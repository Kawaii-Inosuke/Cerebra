import { useAgentsOptional } from "../agents";
import { computePill, useNow } from "../lib/ai";
import { navigate } from "../lib/router";
import { cx } from "../lib/util";

const DOT: Record<string, string> = {
  none: "bg-muted",
  unknown: "bg-muted",
  idle: "bg-success",
  connecting: "bg-accent animate-pulse",
  resting: "bg-[var(--c5)]",
  paused: "bg-muted-strong",
};

/** Agent status in the top bar: No AI source / Idle / Connecting 3 of 12 / Resting until 14:05 / Paused. */
export function StatusPill() {
  const agents = useAgentsOptional();
  const now = useNow(5000);
  const pill = agents
    ? computePill({ sources: agents.sources, settings: agents.settings, jobs: agents.jobs, progress: agents.progress, statuses: agents.statuses, now })
    : { kind: "none" as const, label: "No AI source" };
  const go = () => navigate(pill.kind === "none" ? { name: "ai-sources" } : { name: "agents" });
  return (
    <button
      type="button"
      onClick={go}
      data-testid="status-pill"
      title={pill.kind === "none" ? "Add an AI source so the agents can connect your notes" : "Open the agents"}
      className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 text-[12px] text-muted-strong transition-colors hover:border-border-strong hover:text-fg"
    >
      <span aria-hidden className={cx("size-1.5 rounded-full", DOT[pill.kind])} />
      <span aria-live="polite">{pill.label}</span>
    </button>
  );
}
