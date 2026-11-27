// User actions shared by the sidebar, Home, the command palette and drag-and-drop.
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { MAX_UPLOAD_BYTES, type JobKind } from "./api";
import { checkName, usePrompt } from "./components/Dialogs";
import { useToast } from "./components/Toast";
import { useApi, useLibrary, usePrefs } from "./context";
import { navigate } from "./lib/router";
import { basename, errorMessage, plural, readAsBase64 } from "./lib/util";

export const INBOX = "Inbox";

interface Actions {
  /** Upload files into a collection (or the default one). */
  uploadFiles(files: File[], collection?: string | null): Promise<void>;
  /** Desktop: add files by path (native drag-drop) into a collection. */
  uploadPaths(paths: string[], collection: string): Promise<void>;
  /** Open the OS file chooser, then upload. */
  chooseAndUpload(collection?: string | null): void;
  uploading: boolean;
  newNote(collection?: string | null): Promise<void>;
  newCollection(): Promise<string | null>;
  importVault(): Promise<void>;
  toggleTheme(): void;
  openSettings(): void;
  openGraph(): void;
  connectNote(path: string, title?: string): Promise<void>;
  connectCollection(name: string): Promise<void>;
  connectTopic(): Promise<void>;
  /** Where an upload goes when no collection was chosen. */
  defaultCollection(): string | null;
}

const ActionsContext = createContext<Actions | null>(null);

export function useActionsOptional(): Actions | null {
  return useContext(ActionsContext);
}

export function useActions(): Actions {
  const v = useContext(ActionsContext);
  if (!v) throw new Error("useActions outside ActionsProvider");
  return v;
}

export function ActionsProvider({ children, current }: { children: ReactNode; current?: string | null }) {
  const api = useApi();
  const lib = useLibrary();
  const toast = useToast();
  const prompt = usePrompt();
  const prefs = usePrefs();
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const pendingTarget = useRef<string | null | undefined>(undefined);

  const defaultCollection = useCallback(() => {
    if (current) return current;
    const c = lib.collections;
    if (!c.length) return null;
    return [...c].sort((a, b) => b.notes - a.notes)[0]!.name;
  }, [current, lib.collections]);

  const ensureCollection = useCallback(
    async (name: string) => {
      if (lib.collections.some((c) => c.name === name)) return;
      try {
        await api.createCollection(name);
      } catch (e) {
        if (!/already exists/i.test(errorMessage(e))) throw e;
      }
      await lib.refresh();
    },
    [api, lib],
  );

  const uploadFiles = useCallback(
    async (files: File[], collection?: string | null) => {
      if (!files.length) return;
      const target = collection ?? defaultCollection() ?? INBOX;
      const tooBig = files.filter((f) => f.size > MAX_UPLOAD_BYTES);
      for (const f of tooBig) {
        toast.show({ kind: "error", title: `${f.name} is larger than 25 MB`, description: "Split it into smaller files, or compress it, and try again." });
      }
      const ok = files.filter((f) => f.size <= MAX_UPLOAD_BYTES);
      if (!ok.length) return;
      setUploading(true);
      const tid = toast.show({ kind: "progress", title: `Adding ${plural(ok.length, "file")} to ${target}`, progress: 0 });
      let last: { id: string | null; name: string } | null = null;
      let failed = 0;
      try {
        await ensureCollection(target);
        for (let i = 0; i < ok.length; i++) {
          const f = ok[i]!;
          toast.update(tid, { description: f.name, progress: i / ok.length });
          try {
            const data = await readAsBase64(f);
            const r = await api.upload(target, f.name, data);
            last = { id: r.note_id, name: f.name };
          } catch (e) {
            failed++;
            toast.show({ kind: "error", title: `Couldn't add ${f.name}`, description: errorMessage(e) });
          }
        }
      } catch (e) {
        failed = ok.length;
        toast.show({ kind: "error", title: `Couldn't add files to ${target}`, description: errorMessage(e) });
      } finally {
        setUploading(false);
        toast.dismiss(tid);
        await lib.refresh();
      }
      const done = ok.length - failed;
      if (done > 0 && last) {
        const lastId = last.id;
        toast.show({
          kind: "success",
          title: done === 1 ? `Added ${last.name}` : `Added ${plural(done, "file")} to ${target}`,
          description: done === 1 ? `Saved in ${target} as a note.` : undefined,
          action: lastId ? { label: done === 1 ? "Open note" : "Open the last one", onClick: () => navigate({ name: "note", id: lastId }) } : undefined,
          duration: 7000,
        });
      }
    },
    [api, defaultCollection, ensureCollection, lib, toast],
  );

  const uploadPaths = useCallback(
    async (paths: string[], target: string) => {
      if (!paths.length) return;
      setUploading(true);
      const tid = toast.show({ kind: "progress", title: `Adding ${plural(paths.length, "file")} to ${target}`, progress: 0.1 });
      let results: { name: string; note_id?: string | null; error?: string | null }[] = [];
      try {
        await ensureCollection(target);
        results = await api.uploadPaths(target, paths);
      } catch (e) {
        results = paths.map((p) => ({ name: basename(p), error: errorMessage(e) }));
      } finally {
        setUploading(false);
        toast.dismiss(tid);
        await lib.refresh();
      }
      for (const r of results.filter((r) => r.error)) {
        toast.show({ kind: "error", title: `Couldn't add ${r.name}`, description: r.error ?? undefined });
      }
      const ok = results.filter((r) => !r.error);
      const last = ok[ok.length - 1];
      if (last) {
        const lastId = last.note_id;
        toast.show({
          kind: "success",
          title: ok.length === 1 ? `Added ${last.name}` : `Added ${plural(ok.length, "file")} to ${target}`,
          description: ok.length === 1 ? `Saved in ${target} as a note.` : undefined,
          action: lastId ? { label: ok.length === 1 ? "Open note" : "Open the last one", onClick: () => navigate({ name: "note", id: lastId }) } : undefined,
          duration: 7000,
        });
      }
    },
    [api, ensureCollection, lib, toast],
  );

  const chooseAndUpload = useCallback((collection?: string | null) => {
    pendingTarget.current = collection;
    fileInput.current?.click();
  }, []);

  const newNote = useCallback(
    async (collection?: string | null) => {
      const target = collection === undefined ? current ?? null : collection;
      const v = await prompt({
        title: "New note",
        description: target ? `In ${target}` : "In your Inbox (the library's top folder)",
        fields: [{ name: "title", label: "Title", placeholder: "e.g. Cell membrane", validate: checkName }],
      });
      if (!v) return;
      try {
        const r = await api.newNote(v.title!, target);
        await lib.refresh();
        if (r.id) navigate({ name: "note", id: r.id, edit: true });
      } catch (e) {
        toast.show({ kind: "error", title: "Couldn't create the note", description: errorMessage(e) });
      }
    },
    [api, current, lib, prompt, toast],
  );

  const newCollection = useCallback(async () => {
    const v = await prompt({
      title: "New collection",
      description: "A collection is a folder for one subject, course or project.",
      fields: [
        {
          name: "name",
          label: "Name",
          placeholder: "e.g. Biology",
          validate: (s) => checkName(s) ?? (lib.collections.some((c) => c.name.toLowerCase() === s.trim().toLowerCase()) ? "You already have a collection with that name." : null),
        },
      ],
    });
    if (!v) return null;
    try {
      const r = await api.createCollection(v.name!);
      await lib.refresh();
      toast.show({ kind: "success", title: `Created ${r.name}`, description: "Drop files on it to fill it up." });
      navigate({ name: "collection", collection: r.name });
      return r.name;
    } catch (e) {
      toast.show({ kind: "error", title: "Couldn't create the collection", description: errorMessage(e) });
      return null;
    }
  }, [api, lib, prompt, toast]);

  const importVault = useCallback(async () => {
    let source: string | null = null;
    if (api.desktop) {
      source = await api.pickFolder("Choose the folder of notes to import");
      if (!source) return;
    }
    const fields = [
      ...(source
        ? []
        : [{ name: "source", label: "Notes folder", placeholder: "/home/you/Documents/My notes", hint: "The full path of the folder on this computer.", validate: (s: string) => (s.trim() ? null : "Please enter the folder path.") }]),
      { name: "collection", label: "Import as collection", initial: source ? basename(source) : "", placeholder: "e.g. Old notes", validate: checkName },
    ];
    const v = await prompt({
      title: "Import a folder of notes",
      description: "Cerebra copies the notes and files into a new collection. The original folder stays as it is.",
      fields,
      confirm: "Import",
    });
    if (!v) return;
    const src = source ?? v.source!;
    const tid = toast.show({ kind: "progress", title: `Importing ${basename(src)}…` });
    try {
      const r = await api.importFolder(src, v.collection!);
      toast.dismiss(tid);
      await lib.refresh();
      toast.show({
        kind: "success",
        title: `Imported ${plural(r.notes, "note")} and ${plural(r.files, "file")}`,
        description: [
          r.skipped.length ? `${plural(r.skipped.length, "item")} skipped.` : "",
          r.missing_link_count ? `${plural(r.missing_link_count, "link")} point to notes that don't exist yet.` : "",
        ]
          .filter(Boolean)
          .join(" ") || undefined,
        action: { label: `Open ${r.collection}`, onClick: () => navigate({ name: "collection", collection: r.collection }) },
        duration: 9000,
      });
    } catch (e) {
      toast.dismiss(tid);
      toast.show({ kind: "error", title: "Import didn't work", description: errorMessage(e) });
    }
  }, [api, lib, prompt, toast]);

  const enqueue = useCallback(
    async (kind: JobKind, target: string, what: string) => {
      try {
        await api.jobEnqueue(kind, target);
        toast.show({
          kind: "success",
          title: `Queued: ${what}`,
          description: "The agents will look for valuable connections. New ones appear in Review.",
          action: { label: "See the queue", onClick: () => navigate({ name: "agents" }) },
        });
      } catch (e) {
        toast.show({ kind: "error", title: `Couldn't queue ${what}`, description: errorMessage(e) });
      }
    },
    [api, toast],
  );

  const connectNote = useCallback((path: string, title?: string) => enqueue("connect_note", path, `connect “${title ?? basename(path).replace(/\.md$/i, "")}”`), [enqueue]);
  const connectCollection = useCallback((name: string) => enqueue("connect_collection", name, `connect ${name}`), [enqueue]);
  const connectTopic = useCallback(async () => {
    const v = await prompt({
      title: "Connect a topic",
      description: "The agents gather what your notes say about it into a concept, and link the notes that explain it.",
      fields: [{ name: "topic", label: "Topic", placeholder: "e.g. Photosynthesis", validate: (s) => (s.trim().length < 2 ? "Please enter a topic." : null) }],
      confirm: "Connect",
    });
    if (v) await enqueue("connect_topic", v.topic!, `the topic “${v.topic}”`);
  }, [enqueue, prompt]);

  const value = useMemo<Actions>(
    () => ({
      uploadFiles,
      uploadPaths,
      chooseAndUpload,
      uploading,
      newNote,
      newCollection,
      importVault,
      toggleTheme: prefs.toggleTheme,
      openSettings: () => navigate({ name: "settings" }),
      openGraph: () => navigate({ name: "graph" }),
      defaultCollection,
      connectNote,
      connectCollection,
      connectTopic,
    }),
    [uploadFiles, uploadPaths, chooseAndUpload, uploading, newNote, newCollection, importVault, prefs.toggleTheme, defaultCollection, connectNote, connectCollection, connectTopic],
  );

  return (
    <ActionsContext.Provider value={value}>
      {children}
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          void uploadFiles(files, pendingTarget.current);
        }}
      />
    </ActionsContext.Provider>
  );
}
