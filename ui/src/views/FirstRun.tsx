// First run: one welcome screen with three ways to start, then straight into the app.
import { FileArchive, FolderOpen, FolderPlus } from "lucide-react";
import type { ReactNode } from "react";
import { LogoMark } from "../components/Logo";
import { cx } from "../lib/util";


export function Welcome({ onCreate, onOpen, onOpenFile, busy, error }: { onCreate: () => void; onOpen: () => void; onOpenFile?: () => void; busy: boolean; error: string | null }) {
  return (
    <Frame step={0}>
      <LogoMark className="size-11" />
      <h1 className="mt-6 text-[30px] leading-tight font-semibold tracking-[-0.025em] text-fg">Turn your notes into a connected brain.</h1>
      <p className="mt-3 max-w-[480px] text-[14.5px] leading-relaxed text-muted-strong">
        Add your notes, PDFs and slides, and Cerebra shows how the ideas connect. How would you like to start?
      </p>
      <div className="mt-8 flex w-full max-w-[460px] flex-col gap-2.5">
        <Choice
          icon={<FolderPlus className="size-4" />}
          title="Start a new library"
          text="Pick or make an empty folder. You'll add your notes and files to it next."
          onClick={onCreate}
          disabled={busy}
          primary
        />
        <Choice
          icon={<FolderOpen className="size-4" />}
          title="Use a folder I already have"
          text="A folder of Markdown notes you already keep. Your files stay where they are."
          onClick={onOpen}
          disabled={busy}
        />
        <Choice
          icon={<FileArchive className="size-4" />}
          title="Open notes someone shared"
          text="A .cerebra file from a friend or classmate. Cerebra adds it to a new library."
          onClick={onOpenFile}
          disabled={busy || !onOpenFile}
        />
      </div>
      {error && (
        <p role="alert" className="mt-4 max-w-[460px] rounded-input border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {error}
        </p>
      )}
    </Frame>
  );
}

/** One first-run screen. (`step` is kept for a guided tutorial planned for version 2.) */
function Frame({ children }: { step: number; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col bg-bg">
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pt-8 pb-16">
        <div className="anim-up my-auto flex w-full flex-col items-center text-center">{children}</div>
      </div>
    </div>
  );
}

function Choice({ icon, title, text, onClick, disabled, primary, soon }: { icon: ReactNode; title: string; text: string; onClick?: () => void; disabled?: boolean; primary?: boolean; soon?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cx(
        "flex items-center gap-3 rounded-card border px-4 py-3 text-left transition-[border-color,background] duration-150 ease-out",
        primary ? "border-accent/40 bg-accent-soft hover:border-accent" : "border-border bg-surface hover:border-border-strong hover:bg-surface-2",
        disabled && "opacity-60 hover:border-border hover:bg-surface",
      )}
    >
      <span className={cx("flex size-8 shrink-0 items-center justify-center rounded-input", primary ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted-strong")}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-[14px] font-medium text-fg">
          {title}
          {soon && <span className="rounded-full border border-border px-1.5 text-[10.5px] font-medium text-muted">soon</span>}
        </span>
        <span className="block text-[12.5px] text-muted-strong">{text}</span>
      </span>
    </button>
  );
}


