// Live state of the AI side: sources, agent settings, the job queue and its progress,
// plus a count of suggestions waiting for review. Fed by engine events, with light polling
// while jobs are active.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentsSettings, Job, JobDoneEvent, JobProgress, JobProgressEvent, SourceStatus, SourcesList, UsageRow } from "./api";
import { useToast } from "./components/Toast";
import { useApi, useLibrary } from "./context";
import { friendlyError, jobTitle } from "./lib/ai";

export interface AgentsState {
  /** `null` until loaded; `false` when this build has no AI shell (sources unavailable). */
  sources: SourcesList | null | false;
  settings: AgentsSettings | null;
  jobs: Job[];
  /** Latest live progress per job (events arrive faster than jobs_list). */
  progress: Record<string, JobProgress>;
  statuses: Record<string, SourceStatus>;
  usage: UsageRow[];
  suggested: number;
  /** Bumped whenever the AI layer changes, so views can refetch. */
  aiVersion: number;
  refreshSources(): Promise<void>;
  refreshJobs(): Promise<void>;
  refreshSuggested(): Promise<void>;
  bumpAi(): void;
  saveSettings(patch: Partial<AgentsSettings>): Promise<void>;
}

const Ctx = createContext<AgentsState | null>(null);

export function useAgents(): AgentsState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAgents outside AgentsProvider");
  return v;
}

export function useAgentsOptional(): AgentsState | null {
  return useContext(Ctx);
}

export function AgentsProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const lib = useLibrary();
  const toast = useToast();
  const [sources, setSources] = useState<SourcesList | null | false>(null);
  const [settings, setSettings] = useState<AgentsSettings | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [progress, setProgress] = useState<Record<string, JobProgress>>({});
  const [statuses, setStatuses] = useState<Record<string, SourceStatus>>({});
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [suggested, setSuggested] = useState(0);
  const [aiVersion, setAiVersion] = useState(0);
  const jobsRef = useRef<Job[]>([]);
  const libRefresh = lib.refresh;

  const refreshSources = useCallback(async () => {
    try {
      const s = await api.sourcesList();
      setSources(s);
      setStatuses(s.statuses ?? {});
      if (s.usage) setUsage(s.usage);
    } catch {
      setSources(false);
    }
  }, [api]);

  const refreshJobs = useCallback(async () => {
    try {
      const j = await api.jobsList(60);
      jobsRef.current = j;
      setJobs(j);
    } catch {
      /* engine without jobs: leave empty */
    }
    api.usageToday().then(setUsage).catch(() => {});
  }, [api]);

  const refreshSuggested = useCallback(async () => {
    try {
      const r = await api.aiList({ status: "suggested" });
      setSuggested(r.connections.length + r.concepts.length);
    } catch {
      setSuggested(0);
    }
  }, [api]);

  const bumpAi = useCallback(() => {
    setAiVersion((v) => v + 1);
    void refreshSuggested();
  }, [refreshSuggested]);

  useEffect(() => {
    void refreshSources();
    void refreshJobs();
    void refreshSuggested();
    api.agentsSettingsGet().then(setSettings).catch(() => setSettings(null));
    const offs = [
      api.on<JobProgressEvent>("job-progress", (p) => {
        if (!p?.job_id) return;
        setProgress((m) => ({ ...m, [p.job_id]: { stage: p.stage, done: p.done, total: p.total, message: p.message } }));
        if (!jobsRef.current.some((j) => j.id === p.job_id && j.status === "running")) void refreshJobs();
      }),
      api.on<JobDoneEvent>("job-done", (d) => {
        void refreshJobs();
        if (d?.status === "failed") {
          const job = jobsRef.current.find((j) => j.id === d.job_id);
          toast.show({ kind: "error", title: `Couldn't connect ${job ? jobTitle(job) : "a note"}`, description: friendlyError(d.error) });
        }
      }),
      api.on("jobs-changed", () => void refreshJobs()),
      api.on<UsageRow>("usage", (u) => {
        if (!u?.source_id) return;
        setUsage((rows) => {
          const i = rows.findIndex((r) => r.source_id === u.source_id);
          if (i < 0) return [...rows, u];
          const next = rows.slice();
          next[i] = u;
          return next;
        });
      }),
      api.on<SourceStatus>("source-status", (s) => {
        if (s?.source_id) setStatuses((m) => ({ ...m, [s.source_id!]: s }));
      }),
      api.on("ai-changed", () => {
        bumpAi();
        void libRefresh();
      }),
      api.on<string>("agents-error", (e) => toast.show({ kind: "error", title: "The agents stopped", description: friendlyError(e) })),
      api.on<AgentsSettings>("agents-settings", (s) => s && setSettings(s)),
    ];
    return () => offs.forEach((off) => off());
  }, [api, refreshSources, refreshJobs, refreshSuggested, bumpAi, toast, libRefresh]);

  // Poll while something is queued or running.
  const active = jobs.some((j) => j.status === "running" || j.status === "queued");
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => void refreshJobs(), 4000);
    return () => clearInterval(id);
  }, [active, refreshJobs]);

  // A library change may add or remove connections.
  useEffect(() => {
    void refreshSuggested();
  }, [lib.info, refreshSuggested]);

  const saveSettings = useCallback(
    async (patch: Partial<AgentsSettings>) => {
      if (!settings) return;
      const next = { ...settings, ...patch };
      setSettings(next);
      try {
        setSettings(await api.agentsSettingsSet(next));
      } catch (e) {
        setSettings(settings);
        toast.show({ kind: "error", title: "Couldn't save the setting", description: friendlyError(e instanceof Error ? e.message : String(e)) });
      }
    },
    [api, settings, toast],
  );

  const value = useMemo<AgentsState>(
    () => ({ sources, settings, jobs, progress, statuses, usage, suggested, aiVersion, refreshSources, refreshJobs, refreshSuggested, bumpAi, saveSettings }),
    [sources, settings, jobs, progress, statuses, usage, suggested, aiVersion, refreshSources, refreshJobs, refreshSuggested, bumpAi, saveSettings],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
