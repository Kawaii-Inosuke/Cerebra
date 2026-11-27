// App-wide state: the engine API (injectable for tests), the open library, theme and shell state.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Api, CollectionInfo, LibraryInfo, NoteSummary } from "./api";
import { applyCssZoom, clampZoom, DEFAULT_ZOOM, stepZoom, zoomKey } from "./lib/zoom";
import { applyDensity, applyTheme, loadDensity, loadThemePref, saveThemePref, type Density, type ThemePref } from "./lib/theme";
import { libStore } from "./lib/util";

// ---------- API ----------

const ApiContext = createContext<Api | null>(null);

export function ApiProvider({ api, children }: { api: Api; children: ReactNode }) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export function useApi(): Api {
  const api = useContext(ApiContext);
  if (!api) throw new Error("useApi outside ApiProvider");
  return api;
}

// ---------- Library ----------

export interface LibraryState {
  info: LibraryInfo | null;
  notes: NoteSummary[];
  /** Collections from the engine (empty ones included, with 0 notes). */
  collections: CollectionInfo[];
  /** Collection names in palette order. */
  ordered: string[];
  /** Notes at the library root. */
  inboxCount: number;
  loading: boolean;
  error: string | null;
  refresh(opts?: { reload?: boolean }): Promise<void>;
  recent: string[];
  pushRecent(id: string): void;
}

const LibraryContext = createContext<LibraryState | null>(null);

export function LibraryProvider({ children, enabled = true }: { children: ReactNode; enabled?: boolean }) {
  const api = useApi();
  const [info, setInfo] = useState<LibraryInfo | null>(null);
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const seq = useRef(0);

  const refresh = useCallback(
    async (opts: { reload?: boolean } = {}) => {
      const my = ++seq.current;
      try {
        const i = opts.reload ? await api.reload() : await api.libraryInfo();
        const n = await api.listNotes();
        if (my !== seq.current) return;
        setInfo(i);
        setNotes(n);
        setError(null);
      } catch (e) {
        if (my !== seq.current) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (my === seq.current) setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const off = api.onLibraryChanged(() => void refresh());
    // The preview has no file watcher: catch up when the window regains focus.
    const onFocus = () => {
      if (!api.desktop) void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      off();
      window.removeEventListener("focus", onFocus);
    };
  }, [api, refresh, enabled]);

  const root = info?.root ?? "";
  useEffect(() => {
    if (!root) return;
    setRecent(libStore<string[]>(root, "recent", []).get());
  }, [root]);

  const collections = useMemo(() => [...(info?.collections ?? [])].sort((x, y) => x.name.localeCompare(y.name)), [info]);

  const value: LibraryState = useMemo(
    () => ({
      info,
      notes,
      collections,
      ordered: collections.map((c) => c.name),
      inboxCount: notes.filter((n) => n.collection === null).length,
      loading,
      error,
      refresh,
      recent: recent.filter((id) => notes.some((n) => n.id === id)),
      pushRecent(id: string) {
        setRecent((prev) => {
          const next = [id, ...prev.filter((x) => x !== id)].slice(0, 12);
          if (root) libStore<string[]>(root, "recent", []).set(next);
          return next;
        });
      },
    }),
    [info, notes, collections, loading, error, refresh, recent, root],
  );

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary(): LibraryState {
  const v = useContext(LibraryContext);
  if (!v) throw new Error("useLibrary outside LibraryProvider");
  return v;
}

// ---------- Preferences (theme, density) ----------

interface Prefs {
  theme: ThemePref;
  resolved: "light" | "dark";
  setTheme(t: ThemePref): void;
  toggleTheme(): void;
  density: Density;
  setDensity(d: Density): void;
  /** Text size (zoom factor). */
  zoom: number;
  setZoom(z: number): void;
}

const PrefsContext = createContext<Prefs | null>(null);

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemePref>(loadThemePref);
  const [resolved, setResolved] = useState<"light" | "dark">(() => applyTheme(loadThemePref()));
  const [density, setDensityState] = useState<Density>(loadDensity);
  const api = useContext(ApiContext);
  const [zoom, setZoomState] = useState(DEFAULT_ZOOM);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  useEffect(() => {
    if (!api) return;
    let live = true;
    api
      .getZoom()
      .then((z) => {
        if (!live) return;
        setZoomState(z);
        if (!api.desktop) applyCssZoom(z);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [api]);

  const setZoom = useCallback(
    (z: number) => {
      const target = clampZoom(z);
      setZoomState(target);
      api
        ?.setZoom(target)
        .then((saved) => setZoomState(saved))
        .catch(() => {});
    },
    [api],
  );

  // Ctrl/Cmd + = / − / 0, anywhere (CodeMirror doesn't bind these).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = zoomKey(e);
      if (!a) return;
      e.preventDefault();
      setZoom(a === "reset" ? DEFAULT_ZOOM : stepZoom(zoomRef.current, a === "in" ? 1 : -1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setZoom]);

  useEffect(() => {
    setResolved(applyTheme(theme));
    const on = (e: Event) => setResolved((e as CustomEvent<"light" | "dark">).detail);
    window.addEventListener("cerebra-theme", on);
    return () => window.removeEventListener("cerebra-theme", on);
  }, [theme]);

  useEffect(() => applyDensity(density), [density]);

  const value = useMemo<Prefs>(
    () => ({
      theme,
      resolved,
      setTheme(t) {
        saveThemePref(t);
        setThemeState(t);
      },
      toggleTheme() {
        const next = resolved === "dark" ? "light" : "dark";
        saveThemePref(next);
        setThemeState(next);
      },
      density,
      setDensity: setDensityState,
      zoom,
      setZoom,
    }),
    [theme, resolved, density, zoom, setZoom],
  );
  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs(): Prefs {
  const v = useContext(PrefsContext);
  if (!v) throw new Error("usePrefs outside PrefsProvider");
  return v;
}

// ---------- Shell (panel, palette) ----------

export interface Shell {
  panelOpen: boolean;
  setPanelOpen(v: boolean | ((p: boolean) => boolean)): void;
  paletteOpen: boolean;
  setPaletteOpen(v: boolean): void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed(v: boolean | ((p: boolean) => boolean)): void;
}

const ShellContext = createContext<Shell | null>(null);

export function ShellProvider({ children }: { children: ReactNode }) {
  const [panelOpen, setPanelOpen] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const value = useMemo(
    () => ({ panelOpen, setPanelOpen, paletteOpen, setPaletteOpen, sidebarCollapsed, setSidebarCollapsed }),
    [panelOpen, paletteOpen, sidebarCollapsed],
  );
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export function useShell(): Shell {
  const v = useContext(ShellContext);
  if (!v) throw new Error("useShell outside ShellProvider");
  return v;
}
