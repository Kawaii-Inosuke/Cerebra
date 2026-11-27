// Browser-preview stand-in for the desktop-only AI commands (sources, keychain, agents runner).
// The preview server (`cerebra <library> serve`) has no desktop shell, so without this the
// AI screens could not be tried in a browser. It only switches on when `app_state().preview`
// is true, never inside the desktop app (createTransport doesn't wrap the Tauri transport).
// Keys typed here are never stored: the mock only remembers that one was given.
import type { AgentsSettings, Job, JobProgress, Preset, Source, SourceInput, SourceStatus, Transport, UsageRow } from "./api";

const PRESETS: Preset[] = [
  { provider: "gemini", label: "Google Gemini", model: "gemini-2.5-flash", base_url: null, local: false, needs_key: true, free_tier: true, key_url: "https://aistudio.google.com/apikey" },
  { provider: "groq", label: "Groq", model: "openai/gpt-oss-120b", base_url: "https://api.groq.com/openai/v1", local: false, needs_key: true, free_tier: true, key_url: "https://console.groq.com/keys" },
  { provider: "openrouter", label: "OpenRouter", model: "meta-llama/llama-3.3-70b-instruct:free", base_url: "https://openrouter.ai/api/v1", local: false, needs_key: true, free_tier: true, key_url: "https://openrouter.ai/keys" },
  { provider: "mistral", label: "Mistral", model: "mistral-small-latest", base_url: null, local: false, needs_key: true, free_tier: true, key_url: "https://console.mistral.ai/api-keys" },
  { provider: "openai", label: "OpenAI", model: "gpt-4.1-mini", base_url: null, local: false, needs_key: true, free_tier: false, key_url: "https://platform.openai.com/api-keys" },
  { provider: "anthropic", label: "Anthropic", model: "claude-haiku-5-5", base_url: null, local: false, needs_key: true, free_tier: false, key_url: "https://console.anthropic.com/settings/keys" },
  { provider: "deepseek", label: "DeepSeek", model: "deepseek-chat", base_url: "https://api.deepseek.com/v1", local: false, needs_key: true, free_tier: false, key_url: "https://platform.deepseek.com/api_keys" },
  { provider: "openai_compatible", label: "Custom (OpenAI-compatible)", model: "", base_url: null, local: false, needs_key: true, free_tier: false, key_url: "" },
  { provider: "ollama", label: "Ollama (on this computer)", model: "llama3.1:8b", base_url: "http://localhost:11434", local: true, needs_key: false, free_tier: true, key_url: "https://ollama.com/download" },
  { provider: "lmstudio", label: "LM Studio (on this computer)", model: "local-model", base_url: "http://localhost:1234/v1", local: true, needs_key: false, free_tier: true, key_url: "https://lmstudio.ai" },
];

const CONFIGS: Record<string, string> = {
  claude_desktop: "~/.config/Claude/claude_desktop_config.json",
  claude_code: "~/.claude.json",
  codex: "~/.codex/config.toml",
  cursor: "~/.cursor/mcp.json",
};

const STAGES = ["reading", "finding", "linking", "judging", "saving"];
const STORE_KEY = "cerebra.preview-mock";

interface MockSource extends Source {
  /** Demo only: a key ending in "bad" fails its test. */
  badKey?: boolean;
}

interface MockState {
  sources: MockSource[];
  statuses: Record<string, SourceStatus>;
  settings: AgentsSettings;
  usage: Record<string, UsageRow>;
  /** Job overlays: the preview has no runner, so the mock "runs" queued jobs. */
  jobs: Record<string, { status: string; progress: JobProgress; finished_at?: string; error?: string }>;
  seq: number;
  /** Which AI apps the pretend connector set up. */
  connected?: Record<string, boolean>;
}

const DEFAULT_SETTINGS: AgentsSettings = {
  auto_connect: true,
  threshold: "balanced",
  trust: false,
  budget: 40,
  paused: false,
  auto_delay_secs: 30,
  local_only: [],
};

function load(): MockState {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return { ...fresh(), ...(JSON.parse(raw) as MockState) };
  } catch {
    /* fall through */
  }
  return fresh();
}

function fresh(): MockState {
  return { sources: [], statuses: {}, settings: { ...DEFAULT_SETTINGS }, usage: {}, jobs: {}, seq: 1 };
}

const MOCK_APP = new Set([
  "sources_list",
  "source_add",
  "source_update",
  "source_remove",
  "source_reorder",
  "source_test",
  "detect_local_models",
  "agents_settings_get",
  "agents_settings_set",
  "connector_status",
  "connector_connect",
  "connector_disconnect",
]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function withPreviewMock(base: Transport): Transport {
  let preview: Promise<boolean> | null = null;
  const isPreview = () =>
    (preview ??= base
      .app("app_state")
      .then((s) => !!(s && typeof s === "object" && (s as { preview?: boolean }).preview))
      .catch(() => false));

  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const emit = (event: string, payload: unknown = {}) => listeners.get(event)?.forEach((cb) => cb(payload));
  let state = load();
  const save = () => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  };

  // ---- the fake runner ----
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: { id: string; stage: number; done: number; total: number; target: string } | null = null;
  let lastJobs: Job[] = [];

  const enabledSources = () => state.sources.filter((s) => s.enabled);
  const tick = async () => {
    if (state.settings.paused || !enabledSources().length) return;
    if (!running) {
      const next = [...lastJobs].reverse().find((j) => j.status === "queued" && !state.jobs[j.id]);
      if (!next) {
        if (timer) clearInterval(timer);
        timer = null;
        return;
      }
      running = { id: next.id, stage: 0, done: 0, total: next.kind === "connect_note" ? 5 : 12, target: next.target };
    }
    const r = running;
    r.done = Math.min(r.total, r.done + 1);
    r.stage = Math.min(STAGES.length - 1, Math.floor((r.done / r.total) * STAGES.length));
    const progress = { stage: STAGES[r.stage], done: r.done, total: r.total, message: `Working on ${r.target}` };
    state.jobs[r.id] = { status: "running", progress };
    const src = enabledSources()[0]!;
    const u = (state.usage[src.id] ??= { source_id: src.id, requests: 0, input_tokens: 0, output_tokens: 0 });
    u.requests += 1;
    u.input_tokens += 1800;
    u.output_tokens += 240;
    emit("job-progress", { job_id: r.id, ...progress });
    emit("usage", { ...u });
    if (r.done >= r.total) {
      state.jobs[r.id] = { status: "done", progress, finished_at: new Date().toISOString() };
      emit("job-done", { job_id: r.id, status: "done", saved: { connections: 0, concepts: 0 } });
      emit("jobs-changed", {});
      running = null;
    }
    save();
  };
  const kick = () => {
    if (!timer) timer = setInterval(() => void tick(), 900);
  };

  const overlay = (jobs: Job[]): Job[] => {
    lastJobs = jobs;
    if (jobs.some((j) => j.status === "queued" && !state.jobs[j.id])) kick();
    return jobs.map((j) => {
      const o = state.jobs[j.id];
      if (!o || j.status === "cancelled") return j;
      return { ...j, status: o.status, progress: o.progress, finished_at: o.finished_at ?? j.finished_at, started_at: j.started_at ?? j.created_at };
    });
  };

  const sourcesList = () => ({
    sources: state.sources.map(({ badKey: _b, ...s }) => s),
    presets: PRESETS,
    usage: Object.values(state.usage),
    statuses: state.statuses,
  });

  const fromInput = (input: SourceInput, prev?: MockSource): MockSource => {
    const p = PRESETS.find((x) => x.provider === input.provider);
    return {
      id: prev?.id ?? `${input.provider}-${state.seq++}`,
      provider: input.provider,
      label: input.label?.trim() || prev?.label || p?.label || input.provider,
      model: input.model?.trim() || prev?.model || p?.model || "",
      base_url: input.base_url?.trim() || prev?.base_url || p?.base_url || null,
      enabled: input.enabled ?? prev?.enabled ?? true,
      caps: input.caps ?? prev?.caps ?? {},
      local: p?.local ?? false,
      has_key: prev?.has_key ?? false,
      badKey: prev?.badKey,
    };
  };

  const app = async (cmd: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    switch (cmd) {
      case "sources_list":
        return sourcesList();
      case "source_add": {
        const s = fromInput(args.input as SourceInput);
        const key = typeof args.apiKey === "string" ? args.apiKey : "";
        if (key) {
          s.has_key = true;
          s.badKey = /bad$/i.test(key);
        }
        state.sources.push(s);
        save();
        return s;
      }
      case "source_update": {
        const i = state.sources.findIndex((x) => x.id === args.id);
        if (i < 0) throw new Error("That source no longer exists");
        const s = fromInput(args.input as SourceInput, state.sources[i]);
        const key = typeof args.apiKey === "string" ? args.apiKey : "";
        if (key) {
          s.has_key = true;
          s.badKey = /bad$/i.test(key);
          delete state.statuses[s.id];
        }
        state.sources[i] = s;
        save();
        return s;
      }
      case "source_remove":
        state.sources = state.sources.filter((x) => x.id !== args.id);
        delete state.statuses[args.id as string];
        save();
        return null;
      case "source_reorder": {
        const ids = args.ids as string[];
        state.sources.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
        save();
        return null;
      }
      case "source_test": {
        const s = state.sources.find((x) => x.id === args.id);
        if (!s) throw new Error("Turn the source on to test it");
        await sleep(900);
        const preset = PRESETS.find((p) => p.provider === s.provider);
        if (preset?.needs_key && !s.has_key) return { ok: false, latency_ms: 0, model: s.model, error: "No key saved for this source. Paste one and try again." };
        if (s.badKey) {
          state.statuses[s.id] = { source_id: s.id, state: "disabled", reason: `${s.label} says the key is wrong.` };
          save();
          emit("source-status", state.statuses[s.id]);
          return { ok: false, latency_ms: 412, model: s.model, error: `${s.label} says the key is wrong (401). Paste it again or remove this source.` };
        }
        state.statuses[s.id] = { source_id: s.id, state: "ok", reason: "" };
        save();
        emit("source-status", state.statuses[s.id]);
        return { ok: true, latency_ms: 300 + Math.round(Math.random() * 500), model: s.model };
      }
      case "detect_local_models":
        await sleep(400);
        return { ollama: ["llama3.1:8b", "qwen2.5:7b"], lmstudio: [] };
      case "agents_settings_get":
        return state.settings;
      case "agents_settings_set": {
        const s = { ...(args.settings as AgentsSettings) };
        if (!["strict", "balanced", "generous"].includes(s.threshold)) throw new Error("Choose strict, balanced or generous");
        s.budget = Math.min(200, Math.max(5, Math.round(s.budget)));
        state.settings = s;
        save();
        emit("agents-settings", s);
        if (!s.paused) kick();
        return s;
      }
      case "connector_status":
        return Object.fromEntries(
          (["claude_desktop", "claude_code", "codex", "cursor"] as const).map((a) => [a, { connected: !!state.connected?.[a], config: CONFIGS[a] }]),
        );
      case "connector_connect":
      case "connector_disconnect": {
        const a = String(args.app);
        if (!(a in CONFIGS)) throw new Error("Unknown app");
        await sleep(400);
        state.connected = { ...(state.connected ?? {}), [a]: cmd === "connector_connect" };
        save();
        return null;
      }
      default:
        throw new Error(`unknown command: ${cmd}`);
    }
  };

  // Handy in the browser console for trying the resting / capped states.
  if (typeof window !== "undefined") {
    (window as unknown as Record<string, unknown>).__cerebraMock = {
      setStatus(id: string, st: SourceStatus) {
        state.statuses[id] = { ...st, source_id: id };
        save();
        emit("source-status", state.statuses[id]);
      },
      reset() {
        state = fresh();
        save();
      },
    };
  }

  return {
    desktop: base.desktop,
    async dispatch(cmd, args) {
      const v = await base.dispatch(cmd, args);
      if (!(await isPreview())) return v;
      if (cmd === "jobs_list" && Array.isArray(v)) return overlay(v as Job[]);
      if (cmd === "usage_today") return Object.values(state.usage);
      if (cmd === "job_enqueue") {
        emit("jobs-changed", {});
        kick();
      }
      if (cmd === "job_cancel") {
        const id = (args as { id?: string } | undefined)?.id;
        if (id) {
          delete state.jobs[id];
          if (running?.id === id) running = null;
          save();
        }
        emit("jobs-changed", {});
      }
      return v;
    },
    async app(cmd, args) {
      if (MOCK_APP.has(cmd) && (await isPreview())) return app(cmd, args);
      return base.app(cmd, args);
    },
    listen<T>(event: string, cb: (payload: T) => void) {
      const set = listeners.get(event) ?? new Set();
      const f = cb as (p: unknown) => void;
      set.add(f);
      listeners.set(event, set);
      const off = base.listen(event, cb);
      return () => {
        set.delete(f);
        off();
      };
    },
    fileUrl: (p) => base.fileUrl(p),
    openUrl: (u) => base.openUrl(u),
    onFileDrop: (cb) => base.onFileDrop(cb),
  };
}
