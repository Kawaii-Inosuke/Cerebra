import { PanelRightClose, PanelRightOpen, Search } from "lucide-react";
import { useShell } from "../context";
import { modKey } from "../lib/util";
import { StatusPill } from "./StatusPill";
import { Kbd } from "./ui";

export function TopBar({ title, hasPanel }: { title?: string; hasPanel: boolean }) {
  const shell = useShell();
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-bg px-4">
      <div className="min-w-0 flex-1 truncate text-[13px] font-medium text-muted-strong">{title}</div>
      <button
        type="button"
        data-tour="palette"
        onClick={() => shell.setPaletteOpen(true)}
        className="group flex h-8 w-[min(420px,40vw)] items-center gap-2 rounded-input border border-border bg-surface px-2.5 text-[13px] text-muted transition-colors duration-150 hover:border-border-strong"
        aria-label="Search or run a command"
        aria-keyshortcuts="Control+K Meta+K"
      >
        <Search className="size-3.5" aria-hidden />
        <span className="flex-1 truncate text-left">Search or run a command…</span>
        <Kbd>{modKey}</Kbd>
        <Kbd className="-ml-1.5">K</Kbd>
      </button>
      <div className="flex flex-1 items-center justify-end gap-2">
        <StatusPill />
        {hasPanel && (
          <button
            type="button"
            onClick={() => shell.setPanelOpen((o) => !o)}
            aria-label={shell.panelOpen ? "Hide side panel" : "Show side panel"}
            aria-pressed={shell.panelOpen}
            aria-keyshortcuts="Control+Backslash"
            title={`Toggle panel (${modKey}+\\)`}
            className="rounded-md p-1.5 text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            {shell.panelOpen ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
          </button>
        )}
      </div>
    </header>
  );
}
