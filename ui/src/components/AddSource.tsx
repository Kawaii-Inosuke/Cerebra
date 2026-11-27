// Pick a provider preset, paste a key, save, and test it. Used by AI sources and first run.
import { ArrowUpRight, Check, CircleAlert, KeyRound, Loader2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { Preset, Source, SourceInput, SourceTest } from "../api";
import { useApi } from "../context";
import { friendlyError } from "../lib/ai";
import { cx, errorMessage } from "../lib/util";
import { ExternalLink } from "./ExternalLink";
import { Button } from "./ui";

// Fixed mid-dark tones so white initials stay readable in both themes.
const TILE_COLORS = ["#2563eb", "#047857", "#c2410c", "#be123c", "#0e7490", "#a16207", "#be185d", "#4d7c0f"];

export function ProviderTile({ provider, label, className }: { provider: string; label: string; className?: string }) {
  let h = 0;
  for (const ch of provider) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const initials = label
    .replace(/\(.*\)/, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <span
      aria-hidden
      className={cx("flex size-8 shrink-0 items-center justify-center rounded-input text-[11.5px] font-semibold text-white", className)}
      style={{ background: TILE_COLORS[h % TILE_COLORS.length] }}
    >
      {initials || "AI"}
    </span>
  );
}

export function keyLinkLabel(p: Preset): string {
  if (p.local) return "Download";
  return p.free_tier ? "Get a free key" : "Get a key";
}

export function PresetGrid({ presets, onPick, selected }: { presets: Preset[]; onPick: (p: Preset) => void; selected?: string }) {
  return (
    <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3" aria-label="AI providers">
      {presets.map((p) => (
        <li
          key={p.provider}
          className={cx(
            "flex flex-col gap-2 rounded-card border bg-surface p-3 transition-[border-color,background] duration-150",
            selected === p.provider ? "border-accent bg-accent-soft" : "border-border hover:border-border-strong",
          )}
        >
          <button type="button" onClick={() => onPick(p)} className="flex items-center gap-2.5 text-left" aria-pressed={selected === p.provider}>
            <ProviderTile provider={p.provider} label={p.label} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-[13px] font-medium text-fg">
                <span className="truncate">{p.label}</span>
                {p.free_tier && <span className="rounded-full bg-[color-mix(in_srgb,var(--success)_16%,transparent)] px-1.5 text-[10.5px] font-semibold text-success">free</span>}
              </span>
              <span className="block truncate font-mono text-[11.5px] text-muted">{p.model || "any model"}</span>
            </span>
          </button>
          {p.key_url && (
            <ExternalLink href={p.key_url} className="inline-flex items-center gap-1 self-start text-[12px] text-accent-text hover:underline">
              {keyLinkLabel(p)} <ArrowUpRight className="size-3" aria-hidden />
            </ExternalLink>
          )}
        </li>
      ))}
    </ul>
  );
}

export function TestResult({ result }: { result: SourceTest }) {
  return result.ok ? (
    <p role="status" className="flex items-center gap-1.5 text-[12.5px] text-success">
      <Check className="size-3.5" aria-hidden /> Works · answered in {result.latency_ms} ms{result.model ? ` · ${result.model}` : ""}
    </p>
  ) : (
    <p role="alert" className="flex items-start gap-1.5 text-[12.5px] text-danger">
      <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {readableError(result.error)}
    </p>
  );
}

export function Testing() {
  return (
    <p role="status" className="flex items-center gap-1.5 text-[12.5px] text-muted-strong">
      <Loader2 className="size-3.5 animate-spin" aria-hidden /> Testing… this can take up to a minute.
    </p>
  );
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12.5px] font-medium text-muted-strong">{label}</span>
      {children}
      {hint && <span className="text-[12px] text-muted">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "h-9 rounded-input border border-border bg-bg px-3 text-[13.5px] text-fg outline-none transition-colors placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-accent/25";

/** Form for a new source (or editing one when `source` is given). */
export function SourceForm({
  preset,
  source,
  onDone,
  onCancel,
}: {
  preset: Preset;
  source?: Source;
  onDone: (s: Source, test: SourceTest | null) => void;
  onCancel: () => void;
}) {
  const api = useApi();
  const [key, setKey] = useState("");
  const [model, setModel] = useState(source?.model ?? preset.model);
  const [baseUrl, setBaseUrl] = useState(source?.base_url ?? preset.base_url ?? "");
  const [label, setLabel] = useState(source?.label ?? "");
  const [rpd, setRpd] = useState(source?.caps.requests_per_day ? String(source.caps.requests_per_day) : "");
  const [tpd, setTpd] = useState(source?.caps.tokens_per_day ? String(source.caps.tokens_per_day) : "");
  const [busy, setBusy] = useState<"saving" | "testing" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SourceTest | null>(null);
  const [saved, setSaved] = useState<Source | null>(source ?? null);
  const showUrl = preset.provider === "openai_compatible" || preset.local;
  const needsKey = preset.needs_key && !source?.has_key;

  const submit = async () => {
    setError(null);
    setResult(null);
    if (needsKey && !key.trim()) return setError("Paste the key first. You can get one from the link on the card.");
    if (!model.trim()) return setError("Enter the model name.");
    if (showUrl && !baseUrl.trim()) return setError("Enter the server address.");
    const num = (v: string) => (v.trim() ? Math.max(0, Math.round(Number(v))) || null : null);
    const input: SourceInput = {
      provider: preset.provider,
      model: model.trim(),
      label: label.trim() || undefined,
      base_url: showUrl ? baseUrl.trim() : undefined,
      caps: { requests_per_day: num(rpd), tokens_per_day: num(tpd) },
      enabled: source?.enabled ?? true,
    };
    setBusy("saving");
    let s: Source;
    try {
      s = source ? await api.sourceUpdate(source.id, input, key.trim() || undefined) : saved ? await api.sourceUpdate(saved.id, input, key.trim() || undefined) : await api.sourceAdd(input, key.trim() || undefined);
      setSaved(s);
      setKey("");
    } catch (e) {
      setBusy(null);
      return setError(errorMessage(e));
    }
    setBusy("testing");
    try {
      const r = await api.sourceTest(s.id);
      setResult(r);
      setBusy(null);
      if (r.ok) onDone(s, r);
    } catch (e) {
      setBusy(null);
      setResult({ ok: false, latency_ms: 0, model: s.model, error: errorMessage(e) });
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="anim-up flex flex-col gap-3 rounded-card border border-border bg-surface p-4"
      aria-label={`Set up ${preset.label}`}
    >
      <div className="flex items-center gap-2.5">
        <ProviderTile provider={preset.provider} label={preset.label} />
        <p className="text-[14px] font-semibold text-fg">{source ? `Edit ${source.label}` : preset.label}</p>
      </div>
      {preset.needs_key && (
        <Field
          label={source?.has_key || saved?.has_key ? "New key (optional)" : "API key"}
          hint={
            source?.has_key || saved?.has_key ? (
              <span className="inline-flex items-center gap-1">
                <KeyRound className="size-3" aria-hidden /> Key saved in your system keychain. Paste a new one to replace it.
              </span>
            ) : (
              "Stored in your system keychain, never in the library. Only the last 4 characters are ever shown."
            )
          }
        >
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={preset.key_url ? "Paste the key here" : "Key (if the server needs one)"}
            className={cx(inputClass, "font-mono")}
          />
          {key.trim().length > 4 && <span className="text-[12px] text-muted">Ends in ••••{key.trim().slice(-4)}</span>}
        </Field>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Model">
          <input value={model} onChange={(e) => setModel(e.target.value)} className={cx(inputClass, "font-mono text-[12.5px]")} placeholder="model name" />
        </Field>
        <Field label="Name (optional)">
          <input value={label} onChange={(e) => setLabel(e.target.value)} className={inputClass} placeholder={preset.label} />
        </Field>
      </div>
      {showUrl && (
        <Field label="Server address">
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className={cx(inputClass, "font-mono text-[12.5px]")} placeholder="http://localhost:1234/v1" />
        </Field>
      )}
      <details className="group">
        <summary className="cursor-pointer text-[12.5px] text-muted-strong select-none hover:text-fg">Daily limits (optional)</summary>
        <div className="mt-2 grid grid-cols-2 gap-3">
          <Field label="Requests per day">
            <input inputMode="numeric" value={rpd} onChange={(e) => setRpd(e.target.value.replace(/\D/g, ""))} className={inputClass} placeholder="no limit" />
          </Field>
          <Field label="Tokens per day">
            <input inputMode="numeric" value={tpd} onChange={(e) => setTpd(e.target.value.replace(/\D/g, ""))} className={inputClass} placeholder="no limit" />
          </Field>
        </div>
      </details>
      {error && (
        <p role="alert" className="text-[12.5px] text-danger">
          {error}
        </p>
      )}
      {busy === "testing" && <Testing />}
      {result && <TestResult result={result} />}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={result && !result.ok && saved ? () => onDone(saved, result) : onCancel}>
          {result && !result.ok && saved ? "Keep it anyway" : "Cancel"}
        </Button>
        <Button type="submit" variant="primary" disabled={busy !== null}>
          {busy === "saving" ? "Saving…" : busy === "testing" ? "Testing…" : result && !result.ok ? "Try again" : source ? "Save and test" : "Add and test"}
        </Button>
      </div>
    </form>
  );
}

/** Show the source's own message when it's already plain words; otherwise explain it. */
export function readableError(e: string | null | undefined): string {
  if (e && e.length < 220 && !/[{}<>]|traceback|exception|http\/|status code/i.test(e)) return e;
  return friendlyError(e);
}
