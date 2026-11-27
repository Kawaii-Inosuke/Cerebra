import type { ReactNode } from "react";
import { useShell } from "../context";

export function RightPanel({ children, label }: { children: ReactNode; label: string }) {
  const { panelOpen } = useShell();
  if (!panelOpen) return null;
  return (
    <aside
      aria-label={label}
      className="anim-fade flex h-full w-[320px] shrink-0 flex-col overflow-hidden border-l border-border bg-surface"
    >
      {children}
    </aside>
  );
}

export function PanelHeader({ children }: { children: ReactNode }) {
  return <div className="flex h-11 shrink-0 items-center border-b border-border px-4 text-[12.5px] font-semibold text-fg">{children}</div>;
}
