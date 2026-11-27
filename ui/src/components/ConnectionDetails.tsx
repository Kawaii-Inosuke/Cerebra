// Right panel for one AI connection (a clicked violet arrow in the graph): what links the two notes, why, and the quotes.
import { ArrowDown, Check, X } from "lucide-react";
import { useState } from "react";
import type { AiConnection, AiStatus } from "../api";
import { useAgentsOptional } from "../agents";
import { useApi } from "../context";
import { madeByLabel, typeLabel } from "../lib/ai";
import { navigate } from "../lib/router";
import { errorMessage } from "../lib/util";
import { quotesFor } from "../views/Review";
import { PanelHeader } from "./RightPanel";
import { useToast } from "./Toast";
import { Button, Confidence, SectionLabel } from "./ui";

export function ConnectionDetails({ c, onClose }: { c: AiConnection; onClose: () => void }) {
  const api = useApi();
  const agents = useAgentsOptional();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const q = quotesFor(c);

  const set = async (status: AiStatus) => {
    setBusy(true);
    try {
      await api.aiSetStatus([c.id], status);
      agents?.bumpAi();
      void agents?.refreshSuggested();
      if (status === "dismissed") onClose();
      toast.show({ kind: "success", title: status === "kept" ? "Connection kept" : "Connection rejected", duration: 2200 });
    } catch (e) {
      toast.show({ kind: "error", title: "Couldn't save that", description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PanelHeader>
        <span className="flex-1 truncate">Connection</span>
        <button type="button" onClick={onClose} aria-label="Clear selection" className="rounded-md p-1 text-muted hover:bg-hover hover:text-fg">
          <X className="size-3.5" />
        </button>
      </PanelHeader>
      <div className="flex flex-col gap-4 overflow-y-auto p-4">
        <div className="flex flex-col items-start gap-1.5">
          <NoteLink id={c.from_id} title={c.from_title} />
          <span className="flex items-center gap-1.5 pl-2 text-[12.5px] font-medium text-accent-text">
            <ArrowDown className="size-3.5" aria-hidden />
            <span className="rounded-full border border-accent/40 bg-accent-soft px-2 py-0.5">{typeLabel(c.type)}</span>
          </span>
          <NoteLink id={c.to_id} title={c.to_title} />
        </div>

        <section>
          <SectionLabel className="mb-1.5">Why</SectionLabel>
          <p className="text-[13px] leading-relaxed text-fg">{c.reason}</p>
        </section>

        <section className="flex flex-col gap-2.5">
          <SectionLabel>In your notes</SectionLabel>
          <Quote title={c.from_title} text={q.from} />
          <Quote title={c.to_title} text={q.to} />
        </section>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted">
          <Confidence value={c.confidence} />
          <span>{madeByLabel(c.made_by)}</span>
          <span>{c.status === "suggested" ? "Waiting for review" : "Kept"}</span>
        </div>

        <div className="flex gap-2">
          {c.status === "suggested" && (
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void set("kept")}>
              <Check className="size-3.5" aria-hidden /> Keep
            </Button>
          )}
          <Button size="sm" disabled={busy} onClick={() => void set("dismissed")}>
            <X className="size-3.5" aria-hidden /> {c.status === "suggested" ? "Reject" : "Remove"}
          </Button>
        </div>
      </div>
    </>
  );
}

function NoteLink({ id, title }: { id: string; title: string }) {
  return (
    <button type="button" onClick={() => navigate({ name: "note", id })} className="max-w-full truncate rounded-input border border-border bg-surface px-2.5 py-1 text-left text-[13.5px] font-medium text-fg transition-colors hover:border-border-strong hover:bg-hover">
      {title}
    </button>
  );
}

function Quote({ title, text }: { title: string; text?: string }) {
  return (
    <figure className="border-l-2 border-accent/50 pl-3">
      <figcaption className="text-[11.5px] font-medium text-muted">{title}</figcaption>
      <blockquote className="mt-0.5 text-[12.5px] leading-relaxed text-muted-strong">{text ? `“${text}”` : "No quote"}</blockquote>
    </figure>
  );
}
