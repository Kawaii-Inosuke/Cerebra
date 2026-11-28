// "A new version of Cerebra is available": checked a few seconds after start (unless turned off in
// Settings), with three choices: Update now, Later (ask again in a day), Next time I open Cerebra.
import * as Dialog from "@radix-ui/react-dialog";
import { Download, Sparkles } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useApi } from "../context";
import { LINKS } from "../lib/appInfo";
import { autoCheck, plainNotes, remindLater, snoozed, type UpdateInfo } from "../lib/updates";
import { errorMessage } from "../lib/util";
import { useToast } from "./Toast";
import { Button } from "./ui";

interface UpdatesApi {
  /** Check now (Settings): shows the window if there's a new version, or says Cerebra is up to date. */
  checkNow(): Promise<void>;
}

const UpdatesContext = createContext<UpdatesApi | null>(null);

export function useUpdates(): UpdatesApi | null {
  return useContext(UpdatesContext);
}

/** Wait after start so the check never slows Cerebra down. */
export const START_DELAY_MS = 4000;

export function UpdateProvider({ children, delay = START_DELAY_MS }: { children?: ReactNode; delay?: number }) {
  const api = useApi();
  const toast = useToast();
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const checked = useRef(false);

  // Once per start, quietly: no message when there's nothing new or the check fails (offline…).
  useEffect(() => {
    if (!api.desktop || checked.current || !autoCheck()) return;
    checked.current = true;
    const t = setTimeout(() => {
      api
        .updateCheck()
        .then((u) => {
          if (u && !snoozed(u.version)) setInfo(u);
        })
        .catch(() => {});
    }, delay);
    return () => clearTimeout(t);
  }, [api, delay]);

  const checkNow = useCallback(async () => {
    try {
      const u = await api.updateCheck();
      if (u) setInfo(u);
      else toast.show({ kind: "success", title: "Cerebra is up to date", duration: 2500 });
    } catch (e) {
      toast.show({ kind: "error", title: "Couldn't check for updates", description: errorMessage(e) });
    }
  }, [api, toast]);

  const value = useMemo<UpdatesApi>(() => ({ checkNow }), [checkNow]);

  return (
    <UpdatesContext.Provider value={value}>
      {children}
      {info && <UpdateDialog info={info} onClose={() => setInfo(null)} />}
    </UpdatesContext.Provider>
  );
}

function UpdateDialog({ info, onClose }: { info: UpdateInfo; onClose: () => void }) {
  const api = useApi();
  const toast = useToast();
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number | null } | null>(null);
  const notes = plainNotes(info.notes);

  useEffect(() => api.onUpdateProgress(setProgress), [api]);

  const updateNow = async () => {
    if (info.mode === "download_page") {
      // .deb / .rpm installs: get the new installer from the release page.
      void api.openExternal(LINKS.latest);
      onClose();
      return;
    }
    setInstalling(true);
    try {
      await api.updateInstall();
      // In place: Cerebra restarts by itself. Store: the Store has installed it.
      if (info.mode === "store") {
        toast.show({ kind: "success", title: `Cerebra ${info.version} is installed`, description: "Restart Cerebra if the Store didn't do it for you." });
        onClose();
      }
    } catch (e) {
      setInstalling(false);
      toast.show({ kind: "error", title: "The update didn't finish", description: errorMessage(e) });
    }
  };

  const later = () => {
    remindLater(info.version);
    onClose();
  };

  const pct = progress?.total ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : null;

  return (
    <Dialog.Root open onOpenChange={(o) => !o && !installing && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="anim-fade fixed inset-0 z-50 bg-[var(--overlay)]" />
        <Dialog.Content
          aria-describedby="update-desc"
          onEscapeKeyDown={(e) => installing && e.preventDefault()}
          onPointerDownOutside={(e) => installing && e.preventDefault()}
          className="anim-pop fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-3rem)] w-[440px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-card border border-border bg-surface p-6 shadow-pop"
        >
          <span className="flex size-10 items-center justify-center rounded-input bg-accent-soft text-accent-text">
            <Sparkles className="size-5" aria-hidden />
          </span>
          <div>
            <Dialog.Title className="text-[17px] font-semibold tracking-[-0.01em] text-fg">Cerebra {info.version} is available</Dialog.Title>
            <p id="update-desc" className="mt-1 text-[13.5px] text-muted-strong">
              {info.current ? `You have ${info.current}. ` : ""}
              {info.mode === "store"
                ? "The Microsoft Store will download and install it."
                : info.mode === "download_page"
                  ? "Download the new version from the release page."
                  : "It downloads and installs here, then Cerebra restarts. Your library and settings stay as they are."}
            </p>
          </div>

          {notes && (
            <div className="max-h-[180px] overflow-y-auto rounded-input border border-border bg-surface-2 px-3 py-2">
              <p className="mb-1 text-[11.5px] font-semibold tracking-[0.04em] text-muted uppercase">What's new</p>
              <p className="text-[12.5px] leading-relaxed whitespace-pre-line text-muted-strong">{notes}</p>
            </div>
          )}

          {installing && info.mode === "in_place" && (
            <div>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-label="Downloading the update" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
                <div className="h-full bg-accent transition-[width] duration-200 ease-out" style={{ width: `${pct ?? 15}%` }} />
              </div>
              <p className="mt-1 text-right text-[11.5px] text-muted tabular-nums">{pct === null ? "Downloading…" : `${pct}%`}</p>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <Button variant="primary" onClick={() => void updateNow()} disabled={installing}>
              <Download className="size-3.5" aria-hidden /> {installing ? (info.mode === "store" ? "Updating through the Store…" : "Updating…") : "Update now"}
            </Button>
            <div className="flex gap-2">
              <Button className="flex-1" onClick={later} disabled={installing}>
                Later
              </Button>
              <Button className="flex-1" variant="ghost" onClick={onClose} disabled={installing}>
                Next time I open Cerebra
              </Button>
            </div>
            <p className="text-center text-[11.5px] text-muted">“Later” asks again tomorrow.</p>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
