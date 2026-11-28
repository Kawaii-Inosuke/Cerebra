// The one place the UI talks to the engine. Under Tauri every call is `invoke('dispatch')`
// (plus a few desktop-only commands); in the browser preview the same contract is served by
// `cerebra <library> serve` over `POST /api/dispatch`. Everything else in the UI only sees `Api`.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { applyCssZoom, clampZoom, DEFAULT_ZOOM, ZOOM_KEY } from "./lib/zoom";
import type { UpdateInfo } from "./lib/updates";
import { withPreviewMock } from "./previewMock";

// ---------- Contract types (Phase 1 plan, "UI ⇄ engine contract") ----------

export interface CollectionInfo {
  name: string;
  notes: number;
}

export interface LibraryInfo {
  root: string;
  name: string;
  notes: number;
  files: number;
  collections: CollectionInfo[];
}

export interface NoteSummary {
  id: string;
  path: string;
  title: string;
  tags: string[];
  /** `null` = a note at the library root ("Inbox"). */
  collection: string | null;
}

export interface Heading {
  level: number;
  text: string;
  line: number;
}

export interface LinkItem {
  note_id: string | null;
  title: string;
  path: string | null;
  unresolved: boolean;
  count: number;
}

export interface BacklinkItem {
  note_id: string;
  title: string;
  path: string;
  /** `[1-based line, line text]` per mention. */
  mentions: [number, string][];
}

export interface NoteView {
  id: string;
  path: string;
  title: string;
  html: string;
  text: string;
  tags: string[];
  aliases: string[];
  headings: Heading[];
  outgoing: LinkItem[];
  backlinks: BacklinkItem[];
  source_file: string | null;
  ai_connections: NoteAiConnection[];
}

export interface SearchHit {
  note_id: string;
  path: string;
  title: string;
  heading_path: string;
  /** Matched words are wrapped in `**`. */
  snippet: string;
  line: number;
  score: number;
}

export type NodeKind = "note" | "attachment" | "unresolved" | "tag" | "concept";

export interface GraphNode {
  key: string;
  label: string;
  kind: NodeKind;
  degree: number;
  note_id: string | null;
  collection: string | null;
  dim: boolean;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: [string, string, number][];
  /** `[from_key, to_key, type, status]`; concept edges have type `concept`. */
  ai_edges: [string, string, string, AiStatus][];
}

export interface GraphRequest {
  collection?: string | null;
  focus?: string | null;
  depth?: number;
  unresolved?: boolean;
  tags?: boolean;
  attachments?: boolean;
  hide_orphans?: boolean;
}

export interface ContextPack {
  text: string;
  tokens: number;
  sources: unknown[];
}

export interface UploadResult {
  note_path: string;
  attachment_path: string;
  note_id: string | null;
}

export interface ImportReport {
  collection: string;
  notes: number;
  files: number;
  skipped: string[];
  missing_links: string[];
  missing_link_count: number;
}

export type ModelsStatus = "ready" | "missing" | "downloading" | "unavailable";

export interface AppState {
  library: string | null;
  recent: string[];
  models: ModelsStatus;
  preview: boolean;
}

export interface ModelsProgress {
  done: number;
  total: number;
}

// ---------- AI layer, jobs, sources (Phase 2) ----------

export type AiStatus = "suggested" | "kept" | "dismissed";
export const CONNECTION_TYPES = ["explains", "builds_on", "example_of", "contrasts", "same_concept", "cause_effect", "part_of", "related"] as const;

export interface MadeBy {
  kind: "agent" | "assistant" | "user" | string;
  source?: string;
  job?: string;
}

export interface Evidence {
  note: string;
  quote: string;
}

export interface AiConnection {
  id: string;
  from: string;
  to: string;
  type: string;
  reason: string;
  evidence: Evidence[];
  confidence?: number | null;
  status: AiStatus;
  made_by: MadeBy;
  created_at: string;
  from_title: string;
  to_title: string;
  from_id: string;
  to_id: string;
}

export interface AiConcept {
  id: string;
  title: string;
  summary: string;
  collection: string;
  notes: string[];
  status: AiStatus;
  made_by: MadeBy;
  created_at?: string;
}

export interface NoteAiConnection {
  id: string;
  other_id: string;
  other_title: string;
  other_path: string;
  direction: "in" | "out";
  type: string;
  reason: string;
  evidence: Evidence[];
  confidence?: number | null;
  status: AiStatus;
  made_by: MadeBy;
  created_at: string;
}

export type JobKind = "connect_note" | "connect_collection" | "connect_topic";
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled" | "paused";

export interface JobProgress {
  stage?: string;
  done?: number;
  total?: number;
  message?: string;
}

export interface Job {
  id: string;
  kind: JobKind | string;
  target: string;
  status: JobStatus | string;
  progress: JobProgress | null;
  error: string | null;
  origin: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  attempts: number;
}

export interface UsageRow {
  source_id: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
}

export interface Caps {
  requests_per_day?: number | null;
  tokens_per_day?: number | null;
}

export interface Source {
  id: string;
  label: string;
  provider: string;
  model: string;
  base_url: string | null;
  enabled: boolean;
  caps: Caps;
  local: boolean;
  has_key: boolean;
}

export interface Preset {
  provider: string;
  label: string;
  model: string;
  base_url: string | null;
  local: boolean;
  needs_key: boolean;
  free_tier: boolean;
  key_url: string;
}

export type SourceState = "ok" | "cooling" | "disabled" | "capped";

export interface SourceStatus {
  source_id?: string;
  state: SourceState;
  /** ISO time or unix seconds when a cooling/capped source is ready again. */
  until?: string | number | null;
  reason?: string;
}

export interface SourcesList {
  sources: Source[];
  presets: Preset[];
  usage: UsageRow[];
  statuses: Record<string, SourceStatus>;
}

export interface SourceInput {
  provider: string;
  model?: string;
  base_url?: string;
  label?: string;
  caps?: Caps;
  enabled?: boolean;
}

export interface SourceTest {
  ok: boolean;
  latency_ms: number;
  model: string;
  error?: string | null;
}

export interface AgentsSettings {
  auto_connect: boolean;
  threshold: "strict" | "balanced" | "generous";
  trust: boolean;
  budget: number;
  paused: boolean;
  auto_delay_secs: number;
  local_only: string[];
}

export interface JobProgressEvent extends JobProgress {
  job_id: string;
}

export interface JobDoneEvent {
  job_id: string;
  status: string;
  error?: string | null;
  saved?: { connections?: number; concepts?: number } | null;
}

// ---------- Connector and share files (Phases 3–4) ----------

export const AI_APPS = ["claude_desktop", "claude_code", "codex", "cursor"] as const;
export type AiApp = (typeof AI_APPS)[number];

export interface ConnectorApp {
  connected: boolean;
  /** The Cerebra program the app runs (`<command> mcp`). */
  command?: string | null;
  /** The app's config file Cerebra edits (null when unknown). */
  config: string | null;
  /** Set up by hand instead of one click (Claude Desktop in the Microsoft Store version). */
  manual?: boolean;
}

export type ConnectorStatus = Record<AiApp, ConnectorApp>;

export interface ShareExportOptions {
  collection: string;
  path: string;
  include_files?: boolean;
  include_suggested?: boolean;
  password?: string;
}

export interface ShareInfo {
  title: string;
  description?: string | null;
  created_at?: string | null;
  counts: { notes: number; files: number; connections: number; concepts: number };
  notes: string[];
  encrypted: boolean;
}

export interface UploadPathResult {
  name: string;
  note_path?: string | null;
  attachment_path?: string | null;
  note_id?: string | null;
  error?: string | null;
}

export interface ShareImportResult {
  collection: string;
  notes: number;
  files: number;
  connections: number;
  concepts: number;
}

// ---------- Transport ----------

export interface Transport {
  /** True inside the desktop app. */
  readonly desktop: boolean;
  dispatch(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
  /** Desktop-only commands (`app_state`, `open_library`, …). */
  app(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
  /** Subscribe to an engine event; returns an unsubscribe function. */
  listen<T>(event: string, cb: (payload: T) => void): () => void;
  /** A URL the webview can load for a library-relative file path. */
  fileUrl(path: string): string;
  /** Open a web link in the user's browser. */
  openUrl(url: string): Promise<void>;
  /** Files dropped onto the window from the OS (desktop only; gives absolute paths). */
  onFileDrop(cb: (paths: string[], at?: { x: number; y: number }) => void): () => void;
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Errors become `Error`s carrying the engine's plain-language message. */
export function toError(e: unknown): Error {
  if (e instanceof Error) return e;
  if (typeof e === "string") return new Error(e);
  if (e && typeof e === "object" && "message" in e && typeof e.message === "string") {
    return new Error(e.message);
  }
  return new Error("Something went wrong. Please try again.");
}

export function tauriTransport(): Transport {
  const call = async (cmd: string, args?: Record<string, unknown>) => {
    try {
      return await invoke(cmd, args);
    } catch (e) {
      throw toError(e);
    }
  };
  return {
    desktop: true,
    dispatch: (cmd, args = {}) => call("dispatch", { cmd, args }),
    app: (cmd, args) => call(cmd, args),
    listen<T>(event: string, cb: (payload: T) => void) {
      let off: (() => void) | null = null;
      let cancelled = false;
      listen<T>(event, (e) => cb(e.payload))
        .then((un) => {
          if (cancelled) un();
          else off = un;
        })
        .catch(() => {});
      return () => {
        cancelled = true;
        off?.();
      };
    },
    fileUrl: (path) => convertFileSrc(path, "cerebrafile"),
    async openUrl(url) {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    },
    onFileDrop(cb) {
      let off: (() => void) | null = null;
      let cancelled = false;
      import("@tauri-apps/api/webview")
        .then(({ getCurrentWebview }) =>
          getCurrentWebview().onDragDropEvent((e) => {
            if (e.payload.type === "drop") {
              // Physical pixels → CSS pixels, for elementFromPoint.
              const r = window.devicePixelRatio || 1;
              cb(e.payload.paths, { x: e.payload.position.x / r, y: e.payload.position.y / r });
            }
          }),
        )
        .then((un) => {
          if (cancelled) un();
          else off = un;
        })
        .catch(() => {});
      return () => {
        cancelled = true;
        off?.();
      };
    },
  };
}

/** Each path segment encoded, slashes kept: `/file/Biology/cell%20diagram.png`. */
export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function previewTransport(base = ""): Transport {
  const post = async (url: string, body: unknown) => {
    let res: Response;
    try {
      res = await fetch(`${base}${url}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error("Can't reach Cerebra. Is the preview server still running?");
    }
    const raw = await res.text();
    let value: unknown = null;
    try {
      value = raw ? JSON.parse(raw) : null;
    } catch {
      value = raw;
    }
    if (!res.ok) {
      if (typeof value === "string" && value) throw new Error(value);
      throw new Error(res.status === 413 ? "That file is larger than 25 MB" : `Request failed (${res.status})`);
    }
    return value;
  };
  return {
    desktop: false,
    dispatch: (cmd, args = {}) => post("/api/dispatch", { cmd, args }),
    app: (cmd, args = {}) => post(`/api/app/${cmd}`, args),
    listen: () => () => {},
    fileUrl: (path) => `${base}/file/${encodePath(path)}`,
    async openUrl(url) {
      window.open(url, "_blank", "noopener,noreferrer");
    },
    onFileDrop: () => () => {},
  };
}

export function createTransport(): Transport {
  if (isTauri()) return tauriTransport();
  // The browser preview has no desktop shell: an in-memory stand-in answers the AI-source
  // and agent commands so the screens can be tried. Never used inside the desktop app.
  return withPreviewMock(previewTransport());
}

// ---------- Typed API ----------

export interface Api {
  readonly desktop: boolean;
  libraryInfo(): Promise<LibraryInfo>;
  listNotes(collection?: string | null): Promise<NoteSummary[]>;
  getNote(id: string): Promise<NoteView>;
  search(query: string, opts?: { collection?: string | null; limit?: number }): Promise<SearchHit[]>;
  graph(req?: GraphRequest): Promise<GraphData>;
  contextPack(question: string, collection?: string | null): Promise<ContextPack>;
  upload(collection: string, name: string, dataBase64: string): Promise<UploadResult>;
  importFolder(source: string, collection: string): Promise<ImportReport>;
  createCollection(name: string): Promise<{ name: string }>;
  newNote(title: string, collection?: string | null): Promise<{ id: string | null; path: string }>;
  saveNote(id: string, text: string): Promise<NoteView>;
  reload(): Promise<LibraryInfo>;

  appState(): Promise<AppState>;
  openLibrary(path: string): Promise<unknown>;
  createLibrary(path: string): Promise<unknown>;
  downloadModels(): Promise<unknown>;
  onLibraryChanged(cb: () => void): () => void;
  onModelsProgress(cb: (p: ModelsProgress) => void): () => void;

  aiList(filter?: { status?: AiStatus; collection?: string | null; note_id?: string }): Promise<{ connections: AiConnection[]; concepts: AiConcept[] }>;
  aiSetStatus(ids: string[], status: AiStatus): Promise<{ changed: number }>;
  aiPromoteConcept(id: string): Promise<{ note_path: string; note_id: string | null }>;
  jobsList(limit?: number): Promise<Job[]>;
  jobEnqueue(kind: JobKind, target: string): Promise<{ id: string }>;
  jobCancel(id: string): Promise<unknown>;
  usageToday(): Promise<UsageRow[]>;

  sourcesList(): Promise<SourcesList>;
  sourceAdd(input: SourceInput, apiKey?: string): Promise<Source>;
  sourceUpdate(id: string, input: SourceInput, apiKey?: string): Promise<Source>;
  sourceRemove(id: string): Promise<unknown>;
  sourceReorder(ids: string[]): Promise<unknown>;
  sourceTest(id: string): Promise<SourceTest>;
  detectLocalModels(): Promise<{ ollama: string[]; lmstudio: string[] }>;
  agentsSettingsGet(): Promise<AgentsSettings>;
  agentsSettingsSet(settings: AgentsSettings): Promise<AgentsSettings>;
  /** Engine events: job-progress, job-done, usage, source-status, ai-changed, jobs-changed, agents-error, agents-settings. */
  on<T = unknown>(event: string, cb: (payload: T) => void): () => void;

  connectorStatus(): Promise<ConnectorStatus>;
  connectorConnect(app: AiApp): Promise<unknown>;
  connectorDisconnect(app: AiApp): Promise<unknown>;
  shareExport(o: ShareExportOptions): Promise<{ path: string; bytes: number }>;
  shareInspect(path: string, password?: string): Promise<ShareInfo>;
  shareImport(path: string, opts?: { password?: string; collection?: string }): Promise<ShareImportResult>;
  /** A `.cerebra` file the app was started with (file association), if any. */
  openedFile(): Promise<string | null>;
  /** Native save / open dialogs for share files (desktop only; `null` when cancelled or unavailable). */
  pickSaveFile(defaultPath: string): Promise<string | null>;
  pickShareFile(): Promise<string | null>;
  /** Text size (webview zoom). Default 1.15. */
  getZoom(): Promise<number>;
  setZoom(zoom: number): Promise<number>;
  /** Desktop: add files by their paths (from a native drag-drop). */
  uploadPaths(collection: string, paths: string[]): Promise<UploadPathResult[]>;
  /** Open a web link in the browser (desktop: the system browser). */
  openExternal(url: string): Promise<void>;
  /** Open a library file in the app that normally opens it. */
  openLibraryFile(path: string): Promise<void>;
  /** A newer version, or null (desktop only; always null in the browser preview and development builds). */
  updateCheck(): Promise<UpdateInfo | null>;
  /** Install it: in place and restart (GitHub installs), or through the Microsoft Store. */
  updateInstall(): Promise<void>;
  /** Download progress while installing in place. */
  onUpdateProgress(cb: (p: { done: number; total: number | null }) => void): () => void;
  onFileDrop(cb: (paths: string[], at?: { x: number; y: number }) => void): () => void;

  fileUrl(path: string): string;
  /** Folder picker (desktop only); `null` when cancelled or unavailable. */
  pickFolder(title: string): Promise<string | null>;
}

function clean(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

export function createApi(t: Transport = createTransport()): Api {
  const d = <T>(cmd: string, args: Record<string, unknown> = {}) => t.dispatch(cmd, clean(args)) as Promise<T>;
  return {
    desktop: t.desktop,
    libraryInfo: () => d("library_info"),
    listNotes: (collection) => d("list_notes", { collection }),
    getNote: (id) => d("get_note", { id }),
    search: (query, opts = {}) => d("search", { query, collection: opts.collection, limit: opts.limit }),
    graph: (req = {}) => d("graph", { ...req }),
    contextPack: (question, collection) => d("context_pack", { question, collection }),
    upload: (collection, name, data_base64) => d("upload", { collection, name, data_base64 }),
    importFolder: (source, collection) => d("import_folder", { source, collection }),
    createCollection: (name) => d("create_collection", { name }),
    newNote: (title, collection) => d("new_note", { title, collection }),
    saveNote: (id, text) => d("save_note", { id, text }),
    reload: () => d("reload"),

    appState: () => t.app("app_state") as Promise<AppState>,
    openLibrary: (path) => t.app("open_library", { path }),
    createLibrary: (path) => t.app("create_library", { path }),
    downloadModels: () => t.app("download_models"),
    onLibraryChanged: (cb) => t.listen("library-changed", () => cb()),
    onModelsProgress: (cb) => t.listen<ModelsProgress>("models-progress", cb),

    aiList: (filter = {}) => d("ai_list", { ...filter }),
    aiSetStatus: (ids, status) => d("ai_set_status", { ids, status }),
    aiPromoteConcept: (id) => d("ai_promote_concept", { id }),
    jobsList: (limit) => d("jobs_list", { limit }),
    jobEnqueue: (kind, target) => d("job_enqueue", { kind, target }),
    jobCancel: (id) => d("job_cancel", { id }),
    usageToday: () => d("usage_today"),

    sourcesList: () => t.app("sources_list") as Promise<SourcesList>,
    // Tauri maps Rust's `api_key` parameter to `apiKey`.
    sourceAdd: (input, apiKey) => t.app("source_add", clean({ input, apiKey: apiKey || undefined })) as Promise<Source>,
    sourceUpdate: (id, input, apiKey) => t.app("source_update", clean({ id, input, apiKey: apiKey || undefined })) as Promise<Source>,
    sourceRemove: (id) => t.app("source_remove", { id }),
    sourceReorder: (ids) => t.app("source_reorder", { ids }),
    sourceTest: (id) => t.app("source_test", { id }) as Promise<SourceTest>,
    detectLocalModels: () => t.app("detect_local_models") as Promise<{ ollama: string[]; lmstudio: string[] }>,
    agentsSettingsGet: () => t.app("agents_settings_get") as Promise<AgentsSettings>,
    agentsSettingsSet: (settings) => t.app("agents_settings_set", { settings }) as Promise<AgentsSettings>,
    on: (event, cb) => t.listen(event, cb),

    connectorStatus: () => t.app("connector_status") as Promise<ConnectorStatus>,
    connectorConnect: (app) => t.app("connector_connect", { app }),
    connectorDisconnect: (app) => t.app("connector_disconnect", { app }),
    shareExport: (o) => d("share_export", { ...o, password: o.password || undefined }),
    shareInspect: (path, password) => d("share_inspect", { path, password: password || undefined }),
    shareImport: (path, o = {}) => d("share_import", { path, password: o.password || undefined, collection: o.collection || undefined }),
    async openedFile() {
      if (!t.desktop) return null;
      try {
        const p = await t.app("opened_file");
        return typeof p === "string" && p ? p : null;
      } catch {
        return null;
      }
    },
    async pickSaveFile(defaultPath) {
      if (!t.desktop) return null;
      const { save } = await import("@tauri-apps/plugin-dialog");
      return (await save({ defaultPath, filters: [{ name: "Cerebra share file", extensions: ["cerebra"] }] })) ?? null;
    },
    async pickShareFile() {
      if (!t.desktop) return null;
      const { open } = await import("@tauri-apps/plugin-dialog");
      const p = await open({ multiple: false, directory: false, filters: [{ name: "Cerebra share file", extensions: ["cerebra"] }] });
      return typeof p === "string" ? p : null;
    },
    async getZoom() {
      if (t.desktop) return Number(await t.app("get_zoom")) || DEFAULT_ZOOM;
      try {
        const v = Number(localStorage.getItem(ZOOM_KEY));
        return v ? clampZoom(v) : DEFAULT_ZOOM;
      } catch {
        return DEFAULT_ZOOM;
      }
    },
    async setZoom(zoom) {
      if (t.desktop) return Number(await t.app("set_zoom", { zoom: clampZoom(zoom) }));
      const z = clampZoom(zoom);
      try {
        localStorage.setItem(ZOOM_KEY, String(z));
      } catch {
        /* ignore */
      }
      applyCssZoom(z);
      return z;
    },
    uploadPaths: (collection, paths) => t.app("upload_paths", { collection, paths }) as Promise<UploadPathResult[]>,
    openExternal: (url) => t.openUrl(url),
    async updateCheck() {
      if (!t.desktop) return null;
      const r = await t.app("update_check");
      return r && typeof r === "object" ? (r as UpdateInfo) : null;
    },
    async updateInstall() {
      if (!t.desktop) return;
      await t.app("update_install");
    },
    onUpdateProgress: (cb) => t.listen<{ done: number; total: number | null }>("update-progress", cb),
    async openLibraryFile(path) {
      if (t.desktop) await t.app("open_library_file", { path });
      else window.open(t.fileUrl(path), "_blank", "noopener,noreferrer");
    },
    onFileDrop: (cb) => t.onFileDrop(cb),

    fileUrl: (path) => t.fileUrl(path),
    async pickFolder(title) {
      if (!t.desktop) return null;
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ directory: true, multiple: false, title });
      return typeof picked === "string" ? picked : null;
    },
  };
}

/** Max upload size, checked before reading the file (the engine checks again). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
