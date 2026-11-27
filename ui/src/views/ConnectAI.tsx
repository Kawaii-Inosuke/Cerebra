import { Check, Copy, Plug, RotateCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AI_APPS, type AiApp, type ConnectorStatus } from "../api";
import { inputClass } from "../components/AddSource";
import { useToast } from "../components/Toast";
import { Button, SectionLabel, Spinner } from "../components/ui";
import { useApi, useLibrary } from "../context";
import { cx, errorMessage, plural } from "../lib/util";

export const APP_INFO: Record<AiApp, { name: string; blurb: string }> = {
  claude_desktop: { name: "Claude Desktop", blurb: "Ask Claude about your notes in its desktop app." },
  claude_code: { name: "Claude Code", blurb: "Use your library while coding or writing in the terminal." },
  codex: { name: "Codex", blurb: "Give Codex (desktop or CLI) your notes as context." },
  cursor: { name: "Cursor", blurb: "Search and cite your notes from the editor's AI." },
};

export const TRY_ASKING = [
  "Using my Cerebra notes, explain osmosis and cite the notes",
  "Make me a study guide for Biology from Cerebra",
  "Quiz me on Chemistry using my Cerebra notes",
  "Save the connections we found to Cerebra",
];

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** One card per AI app: Connected ✓ / Remove, or Connect (then "Restart <app>"). */
export function ConnectCards({ compact = false }: { compact?: boolean }) {
  const api = useApi();
  const toast = useToast();
  const [status, setStatus] = useState<ConnectorStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<AiApp | null>(null);
  const [restart, setRestart] = useState<Set<AiApp>>(new Set());
  const [confirm, setConfirm] = useState<AiApp | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.connectorStatus());
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (app: AiApp, connect: boolean) => {
    setBusy(app);
    setConfirm(null);
    try {
      if (connect) await api.connectorConnect(app);
      else await api.connectorDisconnect(app);
      setRestart((s) => new Set(s).add(app));
      await load();
    } catch (e) {
      toast.show({ kind: "error", title: `Couldn't ${connect ? "connect" : "remove"} ${APP_INFO[app].name}`, description: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  if (error) return <p className="text-[13px] text-muted-strong">Connecting AI apps works in the desktop app. ({error})</p>;
  if (!status) return <Spinner />;

  return (
    <ul className={cx("grid grid-cols-1 gap-3", !compact && "md:grid-cols-2")} aria-label="AI apps">
      {AI_APPS.map((app) => {
        const s = status[app];
        const info = APP_INFO[app];
        return (
          <li key={app} className="flex flex-col gap-2 rounded-card border border-border bg-surface p-4 text-left" data-testid={`app-${app}`}>
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-semibold text-fg">{info.name}</span>
              {s?.connected && (
                <span className="inline-flex items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--success)_16%,transparent)] px-2 py-px text-[11.5px] font-medium text-success">
                  <Check className="size-3" aria-hidden /> Connected
                </span>
              )}
              <span className="ml-auto flex gap-1.5">
                {s?.connected ? (
                  confirm === app ? (
                    <>
                      <Button size="sm" variant="danger" onClick={() => void act(app, false)} disabled={busy === app}>
                        Remove from {info.name}?
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                        Keep
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => setConfirm(app)} disabled={busy === app}>
                      Remove
                    </Button>
                  )
                ) : (
                  <Button size="sm" variant="primary" onClick={() => void act(app, true)} disabled={busy === app}>
                    <Plug className="size-3.5" aria-hidden /> {busy === app ? "Connecting…" : "Connect"}
                  </Button>
                )}
              </span>
            </div>
            <p className="text-[12.5px] text-muted-strong">{info.blurb}</p>
            {restart.has(app) && (
              <p role="status" className="flex items-center gap-1.5 text-[12.5px] font-medium text-accent-text">
                <RotateCw className="size-3.5" aria-hidden /> Restart {info.name} to {s?.connected ? "load" : "unload"} Cerebra.
              </p>
            )}
            {s?.config && <p className="truncate font-mono text-[11px] text-muted" title={s.config}>{s.config}</p>}
          </li>
        );
      })}
    </ul>
  );
}

export function ConnectAI() {
  const api = useApi();
  const lib = useLibrary();
  const toast = useToast();
  const [question, setQuestion] = useState("");
  const [collection, setCollection] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [fallback, setFallback] = useState<string | null>(null);

  const copyContext = async () => {
    const q = question.trim();
    if (!q) return;
    setBusy(true);
    setFallback(null);
    try {
      const r = await api.contextPack(q, collection || null);
      if (await copyText(r.text)) toast.show({ kind: "success", title: "Context copied", description: `About ${plural(r.tokens, "token")} from your notes. Paste it into any chat.` });
      else setFallback(r.text);
    } catch (e) {
      toast.show({ kind: "error", title: "Couldn't build the context", description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const [command, setCommand] = useState<string | null>(null);
  useEffect(() => {
    api
      .connectorStatus()
      .then((s) => setCommand(Object.values(s).find((a) => a?.command)?.command ?? null))
      .catch(() => {});
  }, [api]);
  const snippet = JSON.stringify({ mcpServers: { cerebra: { command: command ?? "<path to the Cerebra app>", args: ["mcp"] } } }, null, 2);

  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[860px] flex-col gap-8 px-8 pt-10 pb-20">
        <header>
          <h1 className="text-[24px] font-semibold tracking-[-0.02em] text-fg">Connect your AI</h1>
          <p className="mt-1 text-[13.5px] text-muted-strong">
            Let Claude, Codex or Cursor search and read your library, follow its connections and save new ones. They run Cerebra on this computer; nothing goes through a server.
          </p>
        </header>

        <section className="flex flex-col gap-3">
          <ConnectCards />
          <p className="text-[12px] text-muted">Cerebra backs up each app's config file before changing it.</p>
        </section>

        <section aria-labelledby="try-h">
          <SectionLabel className="mb-2">
            <span id="try-h">Try asking…</span>
          </SectionLabel>
          <ul className="flex flex-col gap-1.5">
            {TRY_ASKING.map((q) => (
              <li key={q} className="group flex items-center gap-2 rounded-input border border-border bg-surface px-3 py-2 text-[13px] text-fg">
                <span className="flex-1">“{q}”</span>
                <button
                  type="button"
                  aria-label={`Copy “${q}”`}
                  onClick={() => void copyText(q).then((ok) => ok && toast.show({ title: "Copied", duration: 1500 }))}
                  className="rounded-md p-1 text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:bg-hover hover:text-fg focus-visible:opacity-100"
                >
                  <Copy className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="copy-h" className="rounded-card border border-border bg-surface p-4">
          <h2 id="copy-h" className="text-[14px] font-semibold text-fg">
            Copy context
          </h2>
          <p className="mt-0.5 text-[12.5px] text-muted-strong">For any other chat app: ask a question, and Cerebra copies the most relevant passages from your notes, ready to paste.</p>
          <form
            className="mt-3 flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void copyContext();
            }}
          >
            <input value={question} onChange={(e) => setQuestion(e.target.value)} className={cx(inputClass, "min-w-[240px] flex-1")} placeholder="e.g. How do plants get water?" aria-label="Question" />
            <select value={collection} onChange={(e) => setCollection(e.target.value)} className={cx(inputClass, "w-auto pr-8")} aria-label="Collection">
              <option value="">All collections</option>
              {lib.collections.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
            <Button type="submit" variant="primary" disabled={busy || !question.trim()} className="h-9">
              <Copy className="size-3.5" aria-hidden /> {busy ? "Gathering…" : "Copy context"}
            </Button>
          </form>
          {fallback && (
            <textarea readOnly value={fallback} aria-label="Context" className="mt-3 h-40 w-full rounded-input border border-border bg-bg p-2 font-mono text-[12px] text-fg" onFocus={(e) => e.currentTarget.select()} />
          )}
        </section>

        <section aria-labelledby="mcp-h">
          <SectionLabel className="mb-2">
            <span id="mcp-h">Any other MCP app</span>
          </SectionLabel>
          <p className="mb-2 text-[12.5px] text-muted-strong">Cerebra is an MCP server. Add this to the app's MCP settings.</p>
          <div className="relative">
            <pre className="overflow-x-auto rounded-card border border-border bg-surface-2 p-3 font-mono text-[12px] text-fg">{snippet}</pre>
            <Button size="sm" className="absolute top-2 right-2" onClick={() => void copyText(snippet).then((ok) => ok && toast.show({ title: "Copied", duration: 1500 }))}>
              <Copy className="size-3.5" aria-hidden /> Copy
            </Button>
          </div>
        </section>
      </div>
    </main>
  );
}
