// Plain-language helpers for the AI side: labels, status pill, errors, countdowns.
import { useEffect, useState } from "react";
import type { AgentsSettings, Job, JobProgress, MadeBy, SourceStatus, SourcesList } from "../api";

export const STAGES = [
  { key: "reading", label: "reading" },
  { key: "finding", label: "finding" },
  { key: "linking", label: "linking" },
  { key: "judging", label: "judging" },
  { key: "saving", label: "saving" },
] as const;

/** Index of a progress stage in STAGES (accepts "finding candidates", "scout", …). */
export function stageIndex(stage: string | undefined): number {
  if (!stage) return -1;
  const s = stage.toLowerCase();
  if (s.startsWith("read")) return 0;
  if (s.startsWith("find") || s.startsWith("scout") || s.includes("candidate")) return 1;
  if (s.startsWith("link")) return 2;
  if (s.startsWith("judg")) return 3;
  if (s.startsWith("sav") || s.startsWith("writ") || s.startsWith("concept")) return 4;
  return -1;
}

const TYPE_LABELS: Record<string, string> = {
  explains: "explains",
  builds_on: "builds on",
  example_of: "example of",
  contrasts: "contrasts with",
  same_concept: "same concept",
  cause_effect: "cause and effect",
  part_of: "part of",
  related: "related",
  concept: "concept",
};

export function typeLabel(t: string): string {
  return TYPE_LABELS[t] ?? t.replace(/_/g, " ");
}

export function madeByLabel(m: MadeBy | undefined): string {
  if (!m) return "";
  if (m.kind === "assistant") return m.source ? `AI app · ${m.source}` : "AI app";
  if (m.kind === "user") return "You";
  return m.source ? `Agent · ${m.source}` : "Agent";
}

export function basenameNoExt(path: string): string {
  const b = path.split("/").pop() ?? path;
  return b.replace(/\.md$/i, "");
}

export function jobTitle(j: Pick<Job, "kind" | "target">): string {
  switch (j.kind) {
    case "connect_note":
      return basenameNoExt(j.target);
    case "connect_collection":
      return `the ${j.target} collection`;
    case "connect_topic":
      return `the topic “${j.target}”`;
    default:
      return j.target;
  }
}

export function jobKindLabel(kind: string): string {
  return kind === "connect_collection" ? "Collection" : kind === "connect_topic" ? "Topic" : "Note";
}

/** Engine/agent errors in plain words, with a fix where we can tell. */
export function friendlyError(e: string | null | undefined): string {
  if (!e) return "Something went wrong. It will be tried again later.";
  const s = e.toLowerCase();
  if (/401|403|unauthori[sz]ed|invalid api key|key is wrong|incorrect api key/.test(s)) return "An AI source rejected its key. Paste the key again in AI sources, or remove that source.";
  if (/429|rate.?limit|quota|too many requests|all .*(busy|resting)/.test(s)) return "All AI sources are resting after hitting their limits. The job will resume on its own.";
  if (/timed? ?out|timeout/.test(s)) return "The AI source took too long to answer. It will be tried again.";
  if (/connection refused|could not connect|failed to connect|localhost:11434|localhost:1234/.test(s)) return "Couldn't reach the AI source. If it runs on this computer, make sure the app (Ollama or LM Studio) is open.";
  if (/local.?only|no local source/.test(s)) return "This collection is local only, and no AI on this computer is set up. Add Ollama or LM Studio in AI sources.";
  if (/no (ai )?source|no enabled source/.test(s)) return "There's no AI source turned on. Add one in AI sources.";
  if (/cancel/.test(s)) return "Cancelled.";
  return e.length > 240 ? `${e.slice(0, 237)}…` : e;
}

/** `until` as ms since epoch (accepts ISO strings and unix seconds). */
export function untilMs(until: string | number | null | undefined): number | null {
  if (until === null || until === undefined || until === "") return null;
  if (typeof until === "number") return until < 1e12 ? until * 1000 : until;
  const n = Number(until);
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  const t = Date.parse(until);
  return Number.isFinite(t) ? t : null;
}

export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

export function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export type PillKind = "none" | "idle" | "connecting" | "resting" | "paused" | "unknown";

export interface Pill {
  kind: PillKind;
  label: string;
}

/** The top-bar agent status (doc 10 §2). */
export function computePill(input: {
  sources: SourcesList | null | false;
  settings: AgentsSettings | null;
  jobs: Job[];
  progress: Record<string, JobProgress>;
  statuses: Record<string, SourceStatus>;
  now: number;
}): Pill {
  const { sources, settings, jobs, progress, statuses, now } = input;
  if (sources === null) return { kind: "unknown", label: "Checking AI…" };
  const enabled = sources ? sources.sources.filter((s) => s.enabled) : [];
  if (!enabled.length) return { kind: "none", label: "No AI source" };
  if (settings?.paused) return { kind: "paused", label: "Paused" };
  const resting = enabled.map((s) => statuses[s.id]).filter((st): st is SourceStatus => !!st && (st.state === "cooling" || st.state === "capped" || st.state === "disabled"));
  if (resting.length === enabled.length) {
    const times = resting.map((st) => untilMs(st.until)).filter((t): t is number => t !== null && t > now);
    if (times.length) return { kind: "resting", label: `Resting until ${clockTime(Math.min(...times))}` };
  }
  const running = jobs.find((j) => j.status === "running");
  if (running) {
    const p = { ...(running.progress ?? {}), ...(progress[running.id] ?? {}) };
    if (p.total) return { kind: "connecting", label: `Connecting ${p.done ?? 0} of ${p.total}` };
    return { kind: "connecting", label: "Connecting…" };
  }
  const queued = jobs.filter((j) => j.status === "queued").length;
  if (queued) return { kind: "connecting", label: `${queued} waiting` };
  return { kind: "idle", label: "Idle" };
}
