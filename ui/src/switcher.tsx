// Which library (folder / vault) is open, and switching between recent ones.
import * as Menu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronsUpDown, FolderOpen, FolderPlus, Info } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { AppState } from "./api";
import { useAbout } from "./components/About";
import { LogoMark } from "./components/Logo";
import { useToast } from "./components/Toast";
import { useApi } from "./context";
import { navigate } from "./lib/router";
import { basename, cx, errorMessage } from "./lib/util";

export interface Switcher {
  current: string | null;
  /** Recent libraries (current first), without ones that turned out to be missing. */
  recent: string[];
  switchTo(path: string): Promise<void>;
  openFolder(): Promise<void>;
  createNew(): Promise<void>;
}

const SwitcherContext = createContext<Switcher | null>(null);

export function useSwitcher(): Switcher | null {
  return useContext(SwitcherContext);
}

export function SwitcherProvider({ state, onChanged, children }: { state: Pick<AppState, "library" | "recent">; onChanged: () => Promise<void>; children: ReactNode }) {
  const api = useApi();
  const toast = useToast();
  const [missing, setMissing] = useState<Set<string>>(new Set());

  const done = useCallback(async () => {
    navigate({ name: "home" }, true);
    await onChanged();
  }, [onChanged]);

  const switchTo = useCallback(
    async (path: string) => {
      if (path === state.library) return;
      try {
        await api.openLibrary(path);
        await done();
      } catch (e) {
        setMissing((m) => new Set(m).add(path));
        toast.show({ kind: "error", title: `Couldn't open ${basename(path)}`, description: errorMessage(e) });
      }
    },
    [api, done, state.library, toast],
  );

  const openFolder = useCallback(async () => {
    if (!api.desktop) {
      toast.show({ title: "Switching libraries works in the desktop app", description: "In the browser preview, restart it with: cerebra <folder> serve" });
      return;
    }
    const path = await api.pickFolder("Choose a library folder");
    if (path) await switchTo(path);
  }, [api, switchTo, toast]);

  const createNew = useCallback(async () => {
    if (!api.desktop) {
      toast.show({ title: "Creating libraries works in the desktop app" });
      return;
    }
    const path = await api.pickFolder("Choose a folder for your new library");
    if (!path) return;
    try {
      await api.createLibrary(path);
      await done();
    } catch (e) {
      toast.show({ kind: "error", title: "Couldn't create the library", description: errorMessage(e) });
    }
  }, [api, done, toast]);

  const value = useMemo<Switcher>(() => {
    const all = [...(state.library ? [state.library] : []), ...state.recent];
    const recent = all.filter((p, i) => all.indexOf(p) === i && !missing.has(p));
    return { current: state.library, recent, switchTo, openFolder, createNew };
  }, [state.library, state.recent, missing, switchTo, openFolder, createNew]);

  return <SwitcherContext.Provider value={value}>{children}</SwitcherContext.Provider>;
}

/** Workspace-switcher dropdown. `sidebar`: logo + "Cerebra" + library; `inline`: "<library> ▾". */
export function LibraryPicker({ variant = "sidebar", fallbackName }: { variant?: "sidebar" | "inline"; fallbackName?: string }) {
  const sw = useSwitcher();
  const about = useAbout();
  const name = sw?.current ? basename(sw.current) : (fallbackName ?? "Library");
  const trigger =
    variant === "sidebar" ? (
      <button type="button" aria-label={`Library: ${name}. Switch library`} className="flex min-w-0 flex-1 items-center gap-2 rounded-input px-1.5 py-1 text-left transition-colors hover:bg-hover">
        <LogoMark />
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] leading-tight font-semibold tracking-[-0.01em] text-fg">Cerebra</span>
          <span className="block truncate text-[11.5px] leading-tight text-muted">{name}</span>
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted" aria-hidden />
      </button>
    ) : (
      <button type="button" aria-label={`Library: ${name}. Switch library`} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-fg transition-colors hover:bg-hover">
        {name}
        <ChevronsUpDown className="size-3 text-muted" aria-hidden />
      </button>
    );
  if (!sw) return trigger;
  return (
    <Menu.Root>
      <Menu.Trigger asChild>{trigger}</Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          align="start"
          sideOffset={6}
          className="anim-pop z-50 w-[280px] overflow-hidden rounded-card border border-border bg-surface p-1 shadow-pop"
        >
          <Menu.Label className="px-2.5 pt-1.5 pb-1 text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">Libraries</Menu.Label>
          {sw.recent.map((p) => {
            const current = p === sw.current;
            return (
              <Menu.Item
                key={p}
                onSelect={() => void sw.switchTo(p)}
                className="flex cursor-pointer items-center gap-2 rounded-input px-2.5 py-1.5 outline-none data-[highlighted]:bg-hover"
              >
                <span className="min-w-0 flex-1">
                  <span className={cx("block truncate text-[13px] text-fg", current && "font-medium")}>{basename(p)}</span>
                  <span className="block truncate text-[11px] text-muted" title={p}>
                    {p}
                  </span>
                </span>
                {current && <Check className="size-3.5 shrink-0 text-accent" aria-label="Open now" />}
              </Menu.Item>
            );
          })}
          <Menu.Separator className="my-1 h-px bg-border" />
          <Menu.Item onSelect={() => void sw.openFolder()} className="flex cursor-pointer items-center gap-2 rounded-input px-2.5 py-1.5 text-[13px] text-fg outline-none data-[highlighted]:bg-hover">
            <FolderOpen className="size-3.5 text-muted" aria-hidden /> Open another folder…
          </Menu.Item>
          <Menu.Item onSelect={() => void sw.createNew()} className="flex cursor-pointer items-center gap-2 rounded-input px-2.5 py-1.5 text-[13px] text-fg outline-none data-[highlighted]:bg-hover">
            <FolderPlus className="size-3.5 text-muted" aria-hidden /> Create a new library…
          </Menu.Item>
          {about && (
            <>
              <Menu.Separator className="my-1 h-px bg-border" />
              <Menu.Item onSelect={() => about.open()} className="flex cursor-pointer items-center gap-2 rounded-input px-2.5 py-1.5 text-[13px] text-fg outline-none data-[highlighted]:bg-hover">
                <Info className="size-3.5 text-muted" aria-hidden /> About Cerebra
              </Menu.Item>
            </>
          )}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
