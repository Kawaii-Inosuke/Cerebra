import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  convertFileSrc: (p: string, proto: string) => `${proto}://localhost/${encodeURIComponent(p)}`,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
const openUrl = vi.fn(async (_url: string) => {});
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (u: string) => openUrl(u) }));

import { createApi, createTransport, encodePath, isTauri, previewTransport, toError } from "./api";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("transport selection", () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.unstubAllGlobals();
    invoke.mockReset();
  });

  it("uses the preview transport in a plain browser", async () => {
    expect(isTauri()).toBe(false);
    const fetchMock = vi.fn(async () => jsonResponse({ root: "/lib", name: "lib", notes: 0, files: 0, collections: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const api = createApi(createTransport());
    expect(api.desktop).toBe(false);
    const info = await api.libraryInfo();
    expect(info.name).toBe("lib");
    expect(fetchMock).toHaveBeenCalledWith("/api/dispatch", expect.objectContaining({ method: "POST", body: JSON.stringify({ cmd: "library_info", args: {} }) }));
    expect(invoke).not.toHaveBeenCalled();
  });

  it("uses invoke('dispatch') under Tauri", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    expect(isTauri()).toBe(true);
    invoke.mockResolvedValueOnce([{ note_id: "n_1" }]);
    const api = createApi(createTransport());
    expect(api.desktop).toBe(true);
    await api.search("cell", { limit: 5 });
    expect(invoke).toHaveBeenCalledWith("dispatch", { cmd: "search", args: { query: "cell", limit: 5 } });
  });

  it("calls desktop commands directly under Tauri", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    invoke.mockResolvedValueOnce({ library: null, recent: [], models: "missing", preview: false });
    const api = createApi(createTransport());
    await api.appState();
    expect(invoke).toHaveBeenCalledWith("app_state", undefined);
    await api.openLibrary("/x");
    expect(invoke).toHaveBeenLastCalledWith("open_library", { path: "/x" });
  });

  it("builds file URLs per transport", () => {
    expect(previewTransport().fileUrl("Biology/cell diagram.png")).toBe("/file/Biology/cell%20diagram.png");
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    expect(createTransport().fileUrl("Biology/a.png")).toBe("cerebrafile://localhost/Biology%2Fa.png");
    expect(encodePath("a b/c#d.md")).toBe("a%20b/c%23d.md");
  });
});

describe("error mapping", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("turns an HTTP 400 JSON string into an Error with the server's message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse("note not found", 400)));
    const api = createApi(previewTransport());
    await expect(api.getNote("nope")).rejects.toThrow(new Error("note not found"));
  });

  it("explains a network failure in plain words", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    await expect(createApi(previewTransport()).libraryInfo()).rejects.toThrow(/Can't reach Cerebra/);
  });

  it("maps a 413 without a body to the size message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 413 })));
    await expect(createApi(previewTransport()).upload("Biology", "big.pdf", "AAAA")).rejects.toThrow("That file is larger than 25 MB");
  });

  it("maps Tauri string rejections to Errors", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    invoke.mockRejectedValueOnce("Collection not found: X");
    await expect(createApi(createTransport()).newNote("T", "X")).rejects.toThrow("Collection not found: X");
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("toError keeps messages from strings and objects", () => {
    expect(toError("boom").message).toBe("boom");
    expect(toError({ message: "nested" }).message).toBe("nested");
    expect(toError(42).message).toMatch(/Something went wrong/);
  });
});

describe("opener", () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    invoke.mockReset();
    openUrl.mockClear();
    vi.restoreAllMocks();
  });

  it("opens web links with the opener plugin under Tauri", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    await createApi(createTransport()).openExternal("https://aistudio.google.com/apikey");
    expect(openUrl).toHaveBeenCalledWith("https://aistudio.google.com/apikey");
    expect(open).not.toHaveBeenCalled();
  });

  it("opens web links in a new tab in the browser", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    await createApi(previewTransport()).openExternal("https://ollama.com/download");
    expect(open).toHaveBeenCalledWith("https://ollama.com/download", "_blank", "noopener,noreferrer");
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("opens library files with open_library_file on desktop, /file/ in the preview", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    invoke.mockResolvedValueOnce(null);
    await createApi(createTransport()).openLibraryFile("Biology/files/unit3.pdf");
    expect(invoke).toHaveBeenCalledWith("open_library_file", { path: "Biology/files/unit3.pdf" });
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    await createApi(previewTransport()).openLibraryFile("Biology/files/unit 3.pdf");
    expect(open).toHaveBeenCalledWith("/file/Biology/files/unit%203.pdf", "_blank", "noopener,noreferrer");
  });

  it("calls the connector and share commands with the contract's arguments", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    invoke.mockResolvedValue(null);
    const api = createApi(createTransport());
    await api.connectorConnect("codex");
    expect(invoke).toHaveBeenLastCalledWith("connector_connect", { app: "codex" });
    await api.shareImport("/x/B.cerebra", { collection: "B2" });
    expect(invoke).toHaveBeenLastCalledWith("dispatch", { cmd: "share_import", args: { path: "/x/B.cerebra", collection: "B2" } });
    await api.openedFile();
    expect(invoke).toHaveBeenLastCalledWith("opened_file", undefined);
  });
});
