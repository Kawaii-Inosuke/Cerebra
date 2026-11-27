import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Api, AppState } from "./api";
import { ActionsProvider } from "./actions";
import { ShareProvider } from "./share";
import { SwitcherProvider, useSwitcher } from "./switcher";
import { AgentsProvider } from "./agents";
import { AboutProvider } from "./components/About";
import { CommandPalette } from "./components/CommandPalette";
import { PromptProvider } from "./components/Dialogs";
import { DesktopDrop } from "./components/DesktopDrop";
import { DropOverlay } from "./components/DropOverlay";
import { Sidebar } from "./components/Sidebar";
import { ToastProvider, useToast } from "./components/Toast";
import { TopBar } from "./components/TopBar";
import { TourProvider } from "./components/Tour";
import { Spinner } from "./components/ui";
import { ApiProvider, LibraryProvider, PrefsProvider, ShellProvider, useApi, useLibrary, useShell } from "./context";
import { navigate, useRoute, type Route } from "./lib/router";
import { errorMessage } from "./lib/util";
import { AISources } from "./views/AISources";
import { Agents } from "./views/Agents";
import { CollectionView } from "./views/CollectionView";
import { ConnectAI } from "./views/ConnectAI";
import { Review } from "./views/Review";
import { Welcome } from "./views/FirstRun";
import { GraphView } from "./views/GraphView";
import { Home } from "./views/Home";
import { NoteView } from "./views/NoteView";
import { Settings } from "./views/Settings";

export function App({ api }: { api: Api }) {
  return (
    <ApiProvider api={api}>
      <PrefsProvider>
        <ToastProvider>
          <PromptProvider>
            <Gate />
          </PromptProvider>
        </ToastProvider>
      </PrefsProvider>
    </ApiProvider>
  );
}

/** Decides between first run and the app, based on `app_state`. */
function Gate() {
  const api = useApi();
  const [state, setState] = useState<AppState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [welcomeError, setWelcomeError] = useState<string | null>(null);
  const [pendingImport, setPendingImport] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await api.appState());
      setLoadError(null);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const choose = async (mode: "create" | "open") => {
    setWelcomeError(null);
    if (!api.desktop) {
      setWelcomeError("Choosing a folder only works in the desktop app. In the browser preview, start it with: cerebra <folder> serve");
      return;
    }
    const path = await api.pickFolder(mode === "create" ? "Choose a folder for your new library" : "Choose a library folder");
    if (!path) return;
    setBusy(true);
    try {
      await (mode === "create" ? api.createLibrary(path) : api.openLibrary(path));
      await load();
    } catch (e) {
      setWelcomeError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const openShareFile = async () => {
    setWelcomeError(null);
    if (!api.desktop) {
      setWelcomeError("Opening a .cerebra file from here only works in the desktop app. In the preview, use “Open a .cerebra file” from the command palette.");
      return;
    }
    const file = await api.pickShareFile();
    if (!file) return;
    const folder = await api.pickFolder("Choose a folder for your new library");
    if (!folder) return;
    setBusy(true);
    try {
      await api.createLibrary(folder);
      setPendingImport(file);
      await load();
    } catch (e) {
      setWelcomeError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };


  if (loadError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <p className="text-[15px] font-medium text-fg">Cerebra couldn't start</p>
        <p className="max-w-md text-[13px] text-muted-strong">{loadError}</p>
        <button type="button" className="text-[13px] text-accent-text hover:underline" onClick={() => void load()}>
          Try again
        </button>
      </div>
    );
  }
  if (!state) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (!state.library) {
    return <Welcome busy={busy} error={welcomeError} onCreate={() => void choose("create")} onOpen={() => void choose("open")} onOpenFile={() => void openShareFile()} />;
  }
  return (
    <SwitcherProvider state={state} onChanged={load}>
    <LibraryProvider key={state.library}>
      <ShellProvider>
        <AgentsProvider>
          <WithActions>
            <ShareProvider initialImport={pendingImport}>
            <AboutProvider>
              <TourProvider>
                <Shell />
              </TourProvider>
            </AboutProvider>
            </ShareProvider>
          </WithActions>
        </AgentsProvider>
      </ShellProvider>
    </LibraryProvider>
    </SwitcherProvider>
  );
}

/** The collection new material goes to, from what's on screen. */
function useCurrentCollection(route: Route): string | null {
  const lib = useLibrary();
  if (route.name === "collection") return route.collection;
  if (route.name === "note") return lib.notes.find((n) => n.id === route.id)?.collection ?? null;
  return null;
}

function WithActions({ children }: { children: ReactNode }) {
  const route = useRoute();
  const current = useCurrentCollection(route);
  return <ActionsProvider current={current}>{children}</ActionsProvider>;
}

function Shell() {
  const api = useApi();
  const switcher = useSwitcher();
  const onSwitchLibrary = api.desktop && switcher ? () => void switcher.openFolder() : undefined;
  const route = useRoute();
  const shell = useShell();
  const lib = useLibrary();
  const toast = useToast();
  const current = useCurrentCollection(route);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === "\\") {
        e.preventDefault();
        shell.setPanelOpen((o) => !o);
      } else if (mod && e.key === ",") {
        e.preventDefault();
        navigate({ name: "settings" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shell]);

  useEffect(() => {
    if (lib.error && lib.info) toast.show({ kind: "error", title: "Couldn't refresh the library", description: lib.error });
  }, [lib.error]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasPanel = route.name === "note" || route.name === "graph" || route.name === "collection";
  const title =
    route.name === "graph" ? "Graph" : route.name === "settings" ? "Settings" : route.name === "review" ? "Review" : route.name === "agents" ? "Agents" : route.name === "ai-sources" ? "AI sources" : route.name === "connect-ai" ? "Connect your AI" : route.name === "collection" ? (route.collection ?? "Inbox") : route.name === "note" ? "" : "Home";

  return (
    <div className="flex h-full">
      <Sidebar route={route} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar title={title} hasPanel={hasPanel} />
        <div className="flex min-h-0 flex-1">
          {route.name === "home" && <Home />}
          {route.name === "graph" && <GraphView key={route.collection ?? ""} focus={route.focus} initialCollection={route.collection ?? null} />}
          {route.name === "note" && <NoteView key={route.id} id={route.id} sub={route.sub} startEditing={route.edit} />}
          {route.name === "collection" && <CollectionView collection={route.collection} />}
          {route.name === "settings" && <Settings onSwitchLibrary={onSwitchLibrary} />}
          {route.name === "review" && <Review />}
          {route.name === "agents" && <Agents />}
          {route.name === "ai-sources" && <AISources />}
          {route.name === "connect-ai" && <ConnectAI />}
        </div>
      </div>
      <CommandPalette />
      {/* Browser: HTML5 drops with File objects. Desktop: native drops with paths. */}
      {api.desktop ? <DesktopDrop current={current} /> : <DropOverlay target={current} />}
    </div>
  );
}
