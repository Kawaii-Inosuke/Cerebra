// An in-memory Api for component tests (no network, no Tauri).
import { vi } from "vitest";
import type { AgentsSettings, AiConcept, AiConnection, Api, LibraryInfo, NoteSummary, NoteView, SourcesList } from "../api";

export function makeNote(over: Partial<NoteView> = {}): NoteView {
  return {
    id: "n_cell",
    path: "Biology/Cell.md",
    title: "Cell",
    html: "<h1 id=\"cell\">Cell</h1><p>A cell has a <a href=\"cerebra://note/n_mem\">Membrane</a>.</p>",
    text: "# Cell\n\nA cell has a [[Membrane]].",
    tags: ["biology"],
    aliases: [],
    headings: [{ level: 1, text: "Cell", line: 0 }],
    outgoing: [{ note_id: "n_mem", title: "Membrane", path: "Biology/Membrane.md", unresolved: false, count: 1 }],
    backlinks: [{ note_id: "n_dna", title: "DNA", path: "Biology/DNA.md", mentions: [[3, "Genes are read in the [[Cell]] nucleus."]] }],
    source_file: null,
    ai_connections: [],
    ...over,
  };
}

/** A kept connection between two of `sampleNotes` (Membrane → Cell). */
export function mapConnection(over: Partial<AiConnection> = {}): AiConnection {
  return {
    id: "c1",
    from: "Biology/Membrane.md",
    to: "Biology/Cell.md",
    type: "part_of",
    reason: "The membrane is the cell's boundary.",
    evidence: [
      { note: "Biology/Membrane.md", quote: "The membrane surrounds the cell." },
      { note: "Biology/Cell.md", quote: "A cell has a membrane." },
    ],
    confidence: 0.86,
    status: "kept",
    made_by: { kind: "agent", source: "groq" },
    created_at: "2026-11-27T10:00:00Z",
    from_title: "Membrane",
    to_title: "Cell",
    from_id: "n_mem",
    to_id: "n_cell",
    ...over,
  };
}

export const sampleNotes: NoteSummary[] = [
  { id: "n_cell", path: "Biology/Cell.md", title: "Cell", tags: ["biology"], collection: "Biology" },
  { id: "n_mem", path: "Biology/Membrane.md", title: "Membrane", tags: [], collection: "Biology" },
  { id: "n_dna", path: "Biology/DNA.md", title: "DNA", tags: [], collection: "Biology" },
  { id: "n_force", path: "Physics/Force.md", title: "Force", tags: [], collection: "Physics" },
];

export const sampleInfo: LibraryInfo = {
  root: "/lib",
  name: "lib",
  notes: 4,
  files: 4,
  collections: [
    { name: "Biology", notes: 3 },
    { name: "Physics", notes: 1 },
  ],
};

export const emptyInfo: LibraryInfo = { root: "/empty", name: "empty", notes: 0, files: 0, collections: [] };

export function makeConnection(over: Partial<AiConnection> = {}): AiConnection {
  return {
    id: "c1",
    from: "Biology/Plants.md",
    to: "Biology/Osmosis.md",
    type: "example_of",
    reason: "Roots taking in water is an example of osmosis.",
    evidence: [
      { note: "Biology/Plants.md", quote: "Plant roots take in water by osmosis" },
      { note: "Biology/Osmosis.md", quote: "Osmosis is water moving across a membrane" },
    ],
    confidence: 0.93,
    status: "suggested",
    made_by: { kind: "agent", source: "groq:llama-3.3-70b-versatile", job: "j1" },
    created_at: "2026-11-26T16:49:12Z",
    from_title: "Plants",
    to_title: "Osmosis",
    from_id: "n_plants",
    to_id: "n_osmosis",
    ...over,
  };
}

export function makeConcept(over: Partial<AiConcept> = {}): AiConcept {
  return {
    id: "k1",
    title: "Water transport",
    summary: "How water moves through living things.",
    collection: "Biology",
    notes: ["Biology/Plants.md", "Biology/Osmosis.md"],
    status: "suggested",
    made_by: { kind: "agent", source: "groq:llama" },
    ...over,
  };
}

export const defaultSettings: AgentsSettings = { auto_connect: true, threshold: "balanced", trust: false, budget: 40, paused: false, auto_delay_secs: 30, local_only: [] };

export const emptySources: SourcesList = {
  sources: [],
  presets: [
    { provider: "gemini", label: "Google Gemini", model: "gemini-2.5-flash", base_url: null, local: false, needs_key: true, free_tier: true, key_url: "https://aistudio.google.com/apikey" },
    { provider: "openai", label: "OpenAI", model: "gpt-4.1-mini", base_url: null, local: false, needs_key: true, free_tier: false, key_url: "https://platform.openai.com/api-keys" },
    { provider: "ollama", label: "Ollama (on this computer)", model: "llama3.1:8b", base_url: "http://localhost:11434", local: true, needs_key: false, free_tier: true, key_url: "https://ollama.com/download" },
  ],
  usage: [],
  statuses: {},
};

export type FakeApi = Api & { emit(event: string, payload?: unknown): void };

export function createFakeApi(over: Partial<Api> = {}, data: { info?: LibraryInfo; notes?: NoteSummary[] } = {}): FakeApi {
  const info = data.info ?? sampleInfo;
  const notes = data.notes ?? sampleNotes;
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const api: FakeApi = {
    emit(event, payload = {}) {
      listeners.get(event)?.forEach((cb) => cb(payload));
    },
    desktop: false,
    libraryInfo: vi.fn(async () => info),
    listNotes: vi.fn(async () => notes),
    getNote: vi.fn(async (id: string) => makeNote({ id })),
    search: vi.fn(async () => []),
    graph: vi.fn(async () => ({ nodes: [], edges: [], ai_edges: [] })),
    contextPack: vi.fn(async () => ({ text: "", tokens: 0, sources: [] })),
    upload: vi.fn(async () => ({ note_path: "Biology/x.md", attachment_path: "Biology/files/x.pdf", note_id: "n_x" })),
    importFolder: vi.fn(async () => ({ collection: "Old", notes: 0, files: 0, skipped: [], missing_links: [], missing_link_count: 0 })),
    createCollection: vi.fn(async (name: string) => ({ name })),
    newNote: vi.fn(async (title: string) => ({ id: "n_new", path: `${title}.md` })),
    saveNote: vi.fn(async (id: string, text: string) => makeNote({ id, text })),
    reload: vi.fn(async () => info),
    appState: vi.fn(async () => ({ library: info.root, recent: [], models: "missing" as const, preview: true })),
    openLibrary: vi.fn(async () => null),
    createLibrary: vi.fn(async () => null),
    downloadModels: vi.fn(async () => null),
    onLibraryChanged: vi.fn(() => () => {}),
    onModelsProgress: vi.fn(() => () => {}),
    aiList: vi.fn(async () => ({ connections: [], concepts: [] })),
    aiSetStatus: vi.fn(async (ids: string[]) => ({ changed: ids.length })),
    aiPromoteConcept: vi.fn(async () => ({ note_path: "Biology/Water transport.md", note_id: "n_wt" })),
    jobsList: vi.fn(async () => []),
    jobEnqueue: vi.fn(async () => ({ id: "j_new" })),
    jobCancel: vi.fn(async () => ({})),
    usageToday: vi.fn(async () => []),
    sourcesList: vi.fn(async () => emptySources),
    sourceAdd: vi.fn(async (input) => ({ id: `${input.provider}-1`, label: "Google Gemini", provider: input.provider, model: input.model ?? "", base_url: null, enabled: true, caps: {}, local: false, has_key: true })),
    sourceUpdate: vi.fn(async (id, input) => ({ id, label: "x", provider: input.provider, model: input.model ?? "", base_url: null, enabled: input.enabled ?? true, caps: {}, local: false, has_key: true })),
    sourceRemove: vi.fn(async () => null),
    sourceReorder: vi.fn(async () => null),
    sourceTest: vi.fn(async () => ({ ok: true, latency_ms: 321, model: "gemini-2.5-flash" })),
    detectLocalModels: vi.fn(async () => ({ ollama: [], lmstudio: [] })),
    agentsSettingsGet: vi.fn(async () => defaultSettings),
    agentsSettingsSet: vi.fn(async (s: AgentsSettings) => s),
    on: vi.fn((event: string, cb: (p: never) => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(cb as (p: unknown) => void);
      listeners.set(event, set);
      return () => set.delete(cb as (p: unknown) => void);
    }),
    connectorStatus: vi.fn(async () => ({
      claude_desktop: { connected: false, config: "/home/me/.config/Claude/claude_desktop_config.json" },
      claude_code: { connected: true, config: "/home/me/.claude.json" },
      codex: { connected: false, config: "/home/me/.codex/config.toml" },
      cursor: { connected: false, config: null },
    })),
    connectorConnect: vi.fn(async () => null),
    connectorDisconnect: vi.fn(async () => null),
    shareExport: vi.fn(async (o) => ({ path: o.path, bytes: 2048 })),
    shareInspect: vi.fn(async () => ({ title: "Biology", description: null, created_at: "2026-11-26T12:00:00Z", counts: { notes: 3, files: 1, connections: 2, concepts: 0 }, notes: ["Cell.md", "DNA.md", "Membrane.md"], encrypted: false })),
    shareImport: vi.fn(async (_p, o) => ({ collection: o?.collection ?? "Biology", notes: 3, files: 1, connections: 2, concepts: 0 })),
    openedFile: vi.fn(async () => null),
    pickSaveFile: vi.fn(async () => null),
    pickShareFile: vi.fn(async () => null),
    getZoom: vi.fn(async () => 1.15),
    setZoom: vi.fn(async (z: number) => z),
    uploadPaths: vi.fn(async (_c: string, paths: string[]) => paths.map((p) => ({ name: p.split("/").pop()!, note_path: `x/${p}`, note_id: "n_up" }))),
    openExternal: vi.fn(async () => {}),
    openLibraryFile: vi.fn(async () => {}),
    updateCheck: vi.fn(async () => null),
    updateInstall: vi.fn(async () => {}),
    onUpdateProgress: vi.fn(() => () => {}),
    onFileDrop: vi.fn(() => () => {}),
    fileUrl: (p: string) => `/file/${p}`,
    pickFolder: vi.fn(async () => null),
    ...over,
  };
  return api;
}
