// "About Cerebra": version, links, licence, credits and bug-report details, in one window.
// Opened from the library menu, the command palette and Settings.
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowLeft, Bug, Check, Copy, FileText, FolderOpen, Network, Plug, ShieldCheck, Sparkles, Tag, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import licenceText from "../../../LICENSE?raw";
import noticesText from "../../../THIRD-PARTY-NOTICES.md?raw";
import { useAgentsOptional } from "../agents";
import { useApi } from "../context";
import { appVersion, BUGREPORT_MODELS, bugReportText, LINKS, newIssueUrl, osName } from "../lib/appInfo";
import { cx, plural } from "../lib/util";
import { LogoMark } from "./Logo";
import { useToast } from "./Toast";
import { Button } from "./ui";

interface AboutApi {
  open(): void;
}

const AboutContext = createContext<AboutApi | null>(null);

export function useAbout(): AboutApi | null {
  return useContext(AboutContext);
}

export function AboutProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const value = useMemo<AboutApi>(() => ({ open: () => setOpen(true) }), []);
  return (
    <AboutContext.Provider value={value}>
      {children}
      <AboutDialog open={open} onOpenChange={setOpen} />
    </AboutContext.Provider>
  );
}

type Page = "main" | "licence" | "notices";

export function AboutDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const api = useApi();
  const agents = useAgentsOptional();
  const toast = useToast();
  const [version, setVersion] = useState<string | null>(null);
  const [models, setModels] = useState<string>("unknown");
  const [page, setPage] = useState<Page>("main");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPage("main");
    setCopied(false);
    let live = true;
    void appVersion(api.desktop).then((v) => live && setVersion(v));
    api
      .appState()
      .then((s) => live && setModels(BUGREPORT_MODELS[s.models] ?? s.models))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open, api]);

  const details = bugReportText({
    version: version ?? "…",
    os: osName(),
    desktop: api.desktop,
    models,
    agents: agentsSummary(agents),
  });

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(details);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.show({ kind: "error", title: "Couldn't copy", description: "Your system didn't allow copying. Select the text and copy it instead." });
    }
  }, [details, toast]);

  const link = (url: string) => () => void api.openExternal(url);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="anim-fade fixed inset-0 z-50 bg-[var(--overlay)]" />
        <Dialog.Content
          aria-describedby="about-desc"
          className="anim-pop fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-3rem)] w-[520px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-card border border-border bg-surface shadow-pop"
        >
          <Dialog.Close asChild>
            <button type="button" aria-label="Close" className="absolute top-3 right-3 rounded-md p-1.5 text-muted transition-colors hover:bg-hover hover:text-fg">
              <X className="size-4" />
            </button>
          </Dialog.Close>

          {page === "main" ? (
            <div className="flex min-h-0 flex-col overflow-y-auto">
              <header className="px-6 pt-6 pb-4 pr-12">
                <div className="flex items-center gap-3.5">
                  <LogoMark className="size-11" />
                  <div>
                    <Dialog.Title className="text-[19px] leading-tight font-semibold tracking-[-0.02em] text-fg">Cerebra</Dialog.Title>
                    <p className="mt-0.5 font-mono text-[12px] text-muted-strong tabular-nums" data-testid="about-version">
                      Version {version ?? "…"}
                    </p>
                  </div>
                </div>
                <p id="about-desc" className="mt-3.5 text-[13.5px] leading-relaxed text-muted-strong">
                  Turn your notes into a connected brain. Cerebra reads your study and work material and shows how the ideas in it link up.
                </p>
              </header>

              <section aria-labelledby="about-what" className="mx-6 mb-4">
                <h3 id="about-what" className="mb-2 text-[12.5px] font-semibold text-fg">
                  What Cerebra does
                </h3>
                <ul className="flex flex-col gap-2">
                  <Point icon={<FolderOpen className="size-3.5" />} title="Keeps your material in one library">
                    Notes, PDFs, Word files, slides and scans, in an ordinary folder on your computer. Scans are read with OCR.
                  </Point>
                  <Point icon={<Sparkles className="size-3.5" />} title="Finds the connections that matter" ai>
                    AI agents read everything and save only links worth keeping, each with a reason and quotes from both notes. You review them; your notes are never changed.
                  </Point>
                  <Point icon={<Network className="size-3.5" />} title="Lets you explore and search">
                    See it all as a graph, and search by meaning, not just exact words.
                  </Point>
                  <Point icon={<Plug className="size-3.5" />} title="Works with your AI">
                    Use a free key (Gemini, Groq) or a model on your computer, and ask Claude, Codex or Cursor questions that cite your own notes.
                  </Point>
                  <Point icon={<ShieldCheck className="size-3.5" />} title="Stays private">
                    No account, no cloud. Everything stays on your computer, and you choose which AI sees what. Share a topic as a .cerebra file.
                  </Point>
                </ul>
              </section>

              <ul className="flex flex-wrap gap-2 px-6" aria-label="Links">
                <LinkButton icon={<Tag className="size-3.5" />} label="Check for updates" onClick={link(LINKS.latest)} />
                <LinkButton icon={<Bug className="size-3.5" />} label="Report a problem" onClick={link(newIssueUrl(details))} />
              </ul>

              <section aria-labelledby="about-licence" className="mx-6 mt-4 rounded-input border border-border bg-surface-2 px-4 py-3">
                <h3 id="about-licence" className="text-[12.5px] font-semibold text-fg">
                  Licence
                </h3>
                <p className="mt-1 text-[12.5px] leading-relaxed text-muted-strong">Free and open source under the MIT licence.</p>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => setPage("licence")}>
                    <FileText className="size-3.5" aria-hidden /> Read the licence
                  </Button>
                  <Button size="sm" onClick={() => setPage("notices")}>
                    <FileText className="size-3.5" aria-hidden /> Third-party notices
                  </Button>
                </div>
              </section>

              <footer className="mt-4 flex items-center justify-between gap-3 border-t border-border px-6 py-3.5">
                <p className="text-[12px] text-muted">Version, system and status only. Never keys or notes.</p>
                <Button size="sm" onClick={() => void copy()} aria-live="polite">
                  {copied ? <Check className="size-3.5 text-success" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
                  {copied ? "Copied" : "Copy details for a bug report"}
                </Button>
              </footer>
            </div>
          ) : (
            <TextPage title={page === "licence" ? "MIT licence" : "Third-party notices"} text={page === "licence" ? reflow(licenceText) : noticesText} onBack={() => setPage("main")} />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Point({ icon, title, children, ai }: { icon: ReactNode; title: string; children: ReactNode; ai?: boolean }) {
  return (
    <li className="flex gap-3">
      <span className={cx("mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-input", ai ? "bg-accent-soft text-accent-text" : "bg-surface-2 text-muted-strong")} aria-hidden>
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-fg">{title}</span>
        <span className="block text-[12.5px] leading-relaxed text-muted-strong">{children}</span>
      </span>
    </li>
  );
}

function LinkButton({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="flex h-8 items-center gap-2 rounded-input border border-border bg-surface px-3 text-[12.5px] whitespace-nowrap text-fg transition-colors duration-150 hover:border-border-strong hover:bg-hover"
      >
        <span className="text-muted">{icon}</span>
        {label}
      </button>
    </li>
  );
}

function TextPage({ title, text, onBack }: { title: string; text: string; onBack: () => void }) {
  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3 pr-12">
        <button type="button" onClick={onBack} aria-label="Back to About" className="rounded-md p-1 text-muted transition-colors hover:bg-hover hover:text-fg">
          <ArrowLeft className="size-4" />
        </button>
        <Dialog.Title className="text-[14px] font-semibold text-fg">{title}</Dialog.Title>
      </div>
      <pre id="about-desc" className="min-h-0 flex-1 overflow-y-auto px-5 py-4 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-muted-strong">
        {text}
      </pre>
    </div>
  );
}

/** Joins hard-wrapped lines into paragraphs so the text wraps to the window instead of twice. */
export function reflow(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/([^\n])\n(?!\n|$)/g, "$1 ");
}

function agentsSummary(a: ReturnType<typeof useAgentsOptional>): string {
  if (!a) return "not loaded";
  if (a.sources === false) return "not available in this build";
  if (a.sources === null) return "loading";
  const running = a.jobs.filter((j) => j.status === "running").length;
  const queued = a.jobs.filter((j) => j.status === "queued").length;
  const parts = [plural(a.sources.sources.length, "AI source")];
  if (a.settings?.paused) parts.push("paused");
  if (running) parts.push(`${running} running`);
  if (queued) parts.push(`${queued} queued`);
  return parts.join(", ");
}
