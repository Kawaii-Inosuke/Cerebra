// Share files (.cerebra): export a collection, and preview + import one (doc 09).
import * as Dialog from "@radix-ui/react-dialog";
import { FileArchive, Lock } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ShareInfo } from "./api";
import { inputClass } from "./components/AddSource";
import { checkName } from "./components/Dialogs";
import { useToast } from "./components/Toast";
import { Button, Spinner, Switch } from "./components/ui";
import { useApi, useLibrary } from "./context";
import { navigate } from "./lib/router";
import { basename, cx, errorMessage, formatBytes, plural } from "./lib/util";

interface ShareApi {
  openExport(collection: string): void;
  /** Start an import; without a path, asks for the file first. */
  openImport(path?: string): void;
}

const ShareContext = createContext<ShareApi | null>(null);

export function useShare(): ShareApi {
  const v = useContext(ShareContext);
  if (!v) throw new Error("useShare outside ShareProvider");
  return v;
}

export function useShareOptional(): ShareApi | null {
  return useContext(ShareContext);
}

export function ShareProvider({ children, initialImport = null }: { children: ReactNode; initialImport?: string | null }) {
  const api = useApi();
  const [exportFor, setExportFor] = useState<string | null>(null);
  const [importing, setImporting] = useState<{ path: string | null } | null>(initialImport ? { path: initialImport } : null);

  const openImport = useCallback(
    (path?: string) => {
      if (path) return setImporting({ path });
      if (api.desktop) {
        void api.pickShareFile().then((p) => p && setImporting({ path: p }));
      } else {
        setImporting({ path: null });
      }
    },
    [api],
  );

  // Desktop: a file the app was opened with (file association).
  useEffect(() => {
    let live = true;
    void api.openedFile().then((p) => live && p && setImporting({ path: p }));
    return () => {
      live = false;
    };
  }, [api]);

  const value = useMemo<ShareApi>(() => ({ openExport: setExportFor, openImport }), [openImport]);

  return (
    <ShareContext.Provider value={value}>
      {children}
      {exportFor !== null && <ExportDialog collection={exportFor} onClose={() => setExportFor(null)} />}
      {importing && <ImportDialog initialPath={importing.path} onClose={() => setImporting(null)} />}
    </ShareContext.Provider>
  );
}

function Shell({ title, description, onClose, children }: { title: string; description: ReactNode; onClose: () => void; children: ReactNode }) {
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="anim-fade fixed inset-0 z-50 bg-[var(--overlay)]" />
        <Dialog.Content className="anim-pop fixed top-[12%] left-1/2 z-50 max-h-[80vh] w-[480px] max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-y-auto rounded-card border border-border bg-surface p-5 shadow-pop">
          <div className="flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-input bg-accent-soft text-accent-text">
              <FileArchive className="size-4" aria-hidden />
            </span>
            <Dialog.Title className="text-[15px] font-semibold text-fg">{title}</Dialog.Title>
          </div>
          <Dialog.Description className="mt-2 text-[13px] leading-relaxed text-muted-strong">{description}</Dialog.Description>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function OptionRow({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-fg">{label}</p>
        <p className="text-[12px] text-muted">{hint}</p>
      </div>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

export function ExportDialog({ collection, onClose }: { collection: string; onClose: () => void }) {
  const api = useApi();
  const toast = useToast();
  const [includeFiles, setIncludeFiles] = useState(true);
  const [includeSuggested, setIncludeSuggested] = useState(true);
  const [password, setPassword] = useState("");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setError(null);
    let target = path.trim();
    if (api.desktop) {
      const picked = await api.pickSaveFile(`${collection}.cerebra`);
      if (!picked) return;
      target = picked;
    } else if (!target) {
      return setError("Enter the full path to save to, for example /home/you/Desktop/" + collection + ".cerebra");
    }
    if (!target.toLowerCase().endsWith(".cerebra")) target += ".cerebra";
    setBusy(true);
    try {
      const r = await api.shareExport({ collection, path: target, include_files: includeFiles, include_suggested: includeSuggested, password: password || undefined });
      onClose();
      toast.show({ kind: "success", title: `Saved ${basename(r.path)}`, description: `${formatBytes(r.bytes)}. Send it any way you like.`, duration: 8000 });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell
      title={`Share ${collection} as a file`}
      description="Anyone with Cerebra can open it and get the same notes, files and connections. No account or sync needed."
      onClose={onClose}
    >
      <div className="mt-3 divide-y divide-border">
        <OptionRow label="Include original files" hint="PDFs, slides and images the notes were made from." checked={includeFiles} onChange={setIncludeFiles} />
        <OptionRow label="Include suggested AI connections" hint="Kept connections are always included; this adds the ones still waiting for review." checked={includeSuggested} onChange={setIncludeSuggested} />
        <div className="flex flex-col gap-1.5 py-2.5">
          <label className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1.5 text-[13px] font-medium text-fg">
              <Lock className="size-3.5 text-muted" aria-hidden /> Password (optional)
            </span>
            <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} placeholder="Leave empty for no password" />
          </label>
          {password && <p className="text-[12px] text-[var(--c5)]">There's no way to recover a forgotten password. Send it separately from the file.</p>}
        </div>
        {!api.desktop && (
          <label className="flex flex-col gap-1.5 py-2.5">
            <span className="text-[13px] font-medium text-fg">Save to</span>
            <input value={path} onChange={(e) => setPath(e.target.value)} className={cx(inputClass, "font-mono text-[12.5px]")} placeholder={`/home/you/Desktop/${collection}.cerebra`} />
            <span className="text-[12px] text-muted">The browser preview can't show a save dialog, so type the full path.</span>
          </label>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-[12.5px] text-danger">
          {error}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void run()} disabled={busy}>
          {busy ? "Saving…" : api.desktop ? "Save as…" : "Save"}
        </Button>
      </div>
    </Shell>
  );
}

export function ImportDialog({ initialPath, onClose }: { initialPath: string | null; onClose: () => void }) {
  const api = useApi();
  const lib = useLibrary();
  const toast = useToast();
  const [path, setPath] = useState(initialPath ?? "");
  const [chosen, setChosen] = useState<string | null>(initialPath);
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [needPassword, setNeedPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef(true);

  const inspect = useCallback(
    async (p: string, pw?: string) => {
      setBusy(true);
      setError(null);
      try {
        const i = await api.shareInspect(p, pw);
        setInfo(i);
        setNeedPassword(false);
        setName((n) => n || i.title);
      } catch (e) {
        const msg = errorMessage(e);
        if (/password/i.test(msg)) {
          setNeedPassword(true);
          if (pw) setError("That password didn't work. Check it and try again.");
        } else setError(msg);
      } finally {
        setBusy(false);
      }
    },
    [api],
  );

  useEffect(() => {
    if (first.current && initialPath) {
      first.current = false;
      void inspect(initialPath);
    }
  }, [initialPath, inspect]);

  const doImport = async () => {
    if (!chosen || !info) return;
    const bad = checkName(name);
    if (bad) return setError(bad);
    setBusy(true);
    setError(null);
    try {
      const r = await api.shareImport(chosen, { password: password || undefined, collection: name.trim() });
      await lib.refresh();
      onClose();
      toast.show({
        kind: "success",
        title: `Imported ${r.collection}`,
        description: `${plural(r.notes, "note")}, ${plural(r.files, "file")} and ${plural(r.connections, "connection")}.`,
        action: { label: `Open ${r.collection}`, onClick: () => navigate({ name: "collection", collection: r.collection }) },
        duration: 9000,
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const taken = !!name.trim() && lib.collections.some((c) => c.name.toLowerCase() === name.trim().toLowerCase());

  return (
    <Shell title="Open a .cerebra file" description="Check what's inside, then add it to this library as a new collection." onClose={onClose}>
      {!chosen && (
        <form
          className="mt-4 flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!path.trim()) return setError("Enter the full path of the .cerebra file.");
            setChosen(path.trim());
            void inspect(path.trim());
          }}
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-fg">File</span>
            <input autoFocus value={path} onChange={(e) => setPath(e.target.value)} className={cx(inputClass, "font-mono text-[12.5px]")} placeholder="/home/you/Downloads/Biology.cerebra" />
          </label>
          <span className="text-[12px] text-muted">The browser preview can't show a file dialog, so type the full path.</span>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary">
              Look inside
            </Button>
          </div>
        </form>
      )}

      {chosen && busy && !info && (
        <div className="mt-4 flex items-center gap-2 text-[13px] text-muted-strong">
          <Spinner /> Reading {basename(chosen)}…
        </div>
      )}

      {chosen && needPassword && (
        <form
          className="mt-4 flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void inspect(chosen, password);
          }}
        >
          <label className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1.5 text-[13px] font-medium text-fg">
              <Lock className="size-3.5 text-muted" aria-hidden /> This file is protected with a password
            </span>
            <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} placeholder="Password" aria-label="Password" />
          </label>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || !password}>
              Unlock
            </Button>
          </div>
        </form>
      )}

      {info && (
        <div className="mt-4 flex flex-col gap-4">
          <div className="rounded-card border border-border bg-bg p-3.5">
            <p className="flex items-center gap-1.5 text-[14px] font-semibold text-fg">
              {info.title}
              {info.encrypted && <Lock className="size-3.5 text-muted" aria-label="Password protected" />}
            </p>
            {info.description && <p className="mt-0.5 text-[12.5px] text-muted-strong">{info.description}</p>}
            <p className="mt-1.5 text-[12.5px] text-muted">
              {plural(info.counts.notes, "note")} · {plural(info.counts.files, "file")} · {plural(info.counts.connections, "connection")} · {plural(info.counts.concepts, "concept")}
            </p>
            {info.notes.length > 0 && (
              <ul className="mt-2.5 flex flex-col gap-0.5" aria-label="Notes inside">
                {info.notes.slice(0, 10).map((n) => (
                  <li key={n} className="truncate text-[12.5px] text-fg">
                    {n.replace(/^notes\//, "").replace(/\.md$/i, "")}
                  </li>
                ))}
                {info.notes.length > 10 && <li className="text-[12px] text-muted">and {plural(info.notes.length - 10, "more note")}</li>}
              </ul>
            )}
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-fg">Collection name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} aria-label="Collection name" />
            {taken && <span className="text-[12px] text-muted">You already have “{name.trim()}”; a number will be added to the new one.</span>}
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void doImport()} disabled={busy}>
              {busy ? "Importing…" : "Import"}
            </Button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 text-[12.5px] text-danger">
          {error}
        </p>
      )}
      {chosen && !busy && !info && !needPassword && error && (
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {!api.desktop && (
            <Button
              onClick={() => {
                setChosen(null);
                setError(null);
              }}
            >
              Choose another file
            </Button>
          )}
        </div>
      )}
    </Shell>
  );
}
