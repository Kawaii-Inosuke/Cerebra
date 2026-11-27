import { CheckCircle2, CircleAlert, Info, Loader2, X } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { cx } from "../lib/util";

export type ToastKind = "info" | "success" | "error" | "progress";

export interface ToastInput {
  kind?: ToastKind;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  /** 0–1 for a progress bar. */
  progress?: number;
  /** ms; 0 = stays until dismissed. Defaults: 4.5 s, errors 8 s, progress never. */
  duration?: number;
}

interface ToastItem extends ToastInput {
  id: number;
}

interface ToastApi {
  show(t: ToastInput): number;
  update(id: number, t: Partial<ToastInput>): void;
  dismiss(id: number): void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const v = useContext(ToastContext);
  if (!v) throw new Error("useToast outside ToastProvider");
  return v;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setItems((xs) => xs.filter((x) => x.id !== id));
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
  }, []);

  const schedule = useCallback(
    (id: number, t: ToastInput) => {
      const old = timers.current.get(id);
      if (old) clearTimeout(old);
      const kind = t.kind ?? "info";
      const ms = t.duration ?? (kind === "progress" ? 0 : kind === "error" ? 8000 : 4500);
      if (ms > 0) timers.current.set(id, setTimeout(() => dismiss(id), ms));
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      show(t) {
        const id = next.current++;
        setItems((xs) => [...xs.slice(-4), { ...t, id }]);
        schedule(id, t);
        return id;
      },
      update(id, patch) {
        setItems((xs) =>
          xs.map((x) => {
            if (x.id !== id) return x;
            const merged = { ...x, ...patch };
            if (patch.kind && patch.kind !== x.kind) schedule(id, merged);
            return merged;
          }),
        );
      },
      dismiss,
    }),
    [dismiss, schedule],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        role="region"
        aria-label="Notifications"
        className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2"
      >
        {items.map((t) => (
          <ToastView key={t.id} t={t} onClose={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastView({ t, onClose }: { t: ToastItem; onClose: () => void }) {
  const kind = t.kind ?? "info";
  const Icon = kind === "success" ? CheckCircle2 : kind === "error" ? CircleAlert : kind === "progress" ? Loader2 : Info;
  return (
    <div
      role={kind === "error" ? "alert" : "status"}
      className="anim-up pointer-events-auto overflow-hidden rounded-card border border-border bg-surface shadow-float"
    >
      <div className="flex items-start gap-3 px-3.5 py-3">
        <Icon
          aria-hidden
          className={cx(
            "mt-0.5 size-4 shrink-0",
            kind === "success" && "text-success",
            kind === "error" && "text-danger",
            kind === "progress" && "animate-spin text-accent",
            kind === "info" && "text-muted",
          )}
        />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-fg">{t.title}</p>
          {t.description && <p className="mt-0.5 text-[12.5px] break-words text-muted-strong">{t.description}</p>}
          {t.action && (
            <button
              type="button"
              onClick={() => {
                t.action!.onClick();
                onClose();
              }}
              className="mt-2 rounded-md text-[12.5px] font-medium text-accent-text hover:underline"
            >
              {t.action.label}
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Dismiss"
          className="-m-1 rounded-md p-1 text-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <X className="size-3.5" />
        </button>
      </div>
      {typeof t.progress === "number" && (
        <div className="h-0.5 bg-surface-2">
          <div className="h-full bg-accent transition-[width] duration-200 ease-out" style={{ width: `${Math.round(t.progress * 100)}%` }} />
        </div>
      )}
    </div>
  );
}
