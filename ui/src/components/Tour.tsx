// The guided tour: offered the first time a library opens, startable again from Settings → Help
// and the command palette. Each step shows the real screen and points at the real control.
import { ArrowLeft, ArrowRight, Compass, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useShell } from "../context";
import { navigate } from "../lib/router";
import { markTour, placeCard, TOUR_STEPS, tourSeen, type Box, type TourStep } from "../lib/tour";
import { cx } from "../lib/util";
import { Button } from "./ui";

interface TourApi {
  start(): void;
}

const TourContext = createContext<TourApi | null>(null);

export function useTour(): TourApi | null {
  return useContext(TourContext);
}

/** `offer` = the "want a tour?" card; a number = that step. */
type Phase = "offer" | number | null;

export function TourProvider({ children, autoOffer = true, steps = TOUR_STEPS }: { children?: ReactNode; autoOffer?: boolean; steps?: TourStep[] }) {
  const [phase, setPhase] = useState<Phase>(null);
  const shell = useShell();

  // First time a library is open: offer the tour once the app has settled.
  useEffect(() => {
    if (!autoOffer || tourSeen()) return;
    const t = setTimeout(() => setPhase((p) => (p === null ? "offer" : p)), 500);
    return () => clearTimeout(t);
  }, [autoOffer]);

  const go = useCallback(
    (i: number) => {
      const step = steps[i];
      if (!step) return;
      shell.setPaletteOpen(false);
      shell.setSidebarCollapsed(false);
      if (step.route) navigate(step.route);
      setPhase(i);
    },
    [shell, steps],
  );

  const end = useCallback(
    (outcome: "done" | "skipped") => {
      const touring = typeof phase === "number";
      markTour(outcome);
      setPhase(null);
      if (touring) navigate({ name: "home" });
    },
    [phase],
  );

  const value = useMemo<TourApi>(() => ({ start: () => go(0) }), [go]);

  return (
    <TourContext.Provider value={value}>
      {children}
      {phase === "offer" && <OfferCard onStart={() => go(0)} onSkip={() => end("skipped")} />}
      {typeof phase === "number" && steps[phase] && (
        <StepCard
          step={steps[phase]}
          index={phase}
          total={steps.length}
          onBack={() => go(phase - 1)}
          onNext={() => (phase + 1 < steps.length ? go(phase + 1) : end("done"))}
          onSkip={() => end("skipped")}
        />
      )}
    </TourContext.Provider>
  );
}

// ---------- Pieces ----------

const CARD_WIDTH = 340;

function OfferCard({ onStart, onSkip }: { onStart: () => void; onSkip: () => void }) {
  return (
    <Layer onEscape={onSkip} dim>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-offer-title"
        aria-describedby="tour-offer-desc"
        className="anim-pop fixed top-1/2 left-1/2 w-[400px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-card border border-border bg-surface p-6 shadow-pop"
      >
        <span className="flex size-10 items-center justify-center rounded-input bg-accent-soft text-accent-text">
          <Compass className="size-5" aria-hidden />
        </span>
        <h2 id="tour-offer-title" className="mt-4 text-[17px] font-semibold tracking-[-0.01em] text-fg">
          Want a quick tour?
        </h2>
        <p id="tour-offer-desc" className="mt-1.5 text-[13.5px] leading-relaxed text-muted-strong">
          About a minute, ten short stops: where your notes go, how the AI finds connections, and how to use them from Claude or Codex.
        </p>
        <div className="mt-5 flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onSkip}>
            Skip for now
          </Button>
          <Button variant="primary" onClick={onStart} autoFocus>
            Show me around <ArrowRight className="size-3.5" aria-hidden />
          </Button>
        </div>
        <p className="mt-4 text-[12px] text-muted">You can start it again any time from Settings → Help.</p>
      </div>
    </Layer>
  );
}

function StepCard({ step, index, total, onBack, onNext, onSkip }: { step: TourStep; index: number; total: number; onBack: () => void; onNext: () => void; onSkip: () => void }) {
  const rect = useTargetRect(step.target);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardH, setCardH] = useState(190);
  const nextRef = useRef<HTMLButtonElement>(null);
  const last = index === total - 1;

  useLayoutEffect(() => {
    if (cardRef.current) setCardH(cardRef.current.offsetHeight);
  }, [step.id]);
  useEffect(() => nextRef.current?.focus(), [step.id]);

  const z = pageZoom();
  const vp = { width: window.innerWidth / z, height: window.innerHeight / z };
  const pos = placeCard(rect, { width: Math.min(CARD_WIDTH, vp.width - 24), height: cardH }, vp);
  const pad = 6;
  // The ring stays inside the window even for controls at its very edge.
  const spot = rect && {
    top: Math.max(2, rect.top - pad),
    left: Math.max(2, rect.left - pad),
    right: Math.min(vp.width - 2, rect.left + rect.width + pad),
    bottom: Math.min(vp.height - 2, rect.top + rect.height + pad),
  };

  return (
    <Layer
      onEscape={onSkip}
      onKey={(e) => {
        if (e.key === "ArrowRight") onNext();
        else if (e.key === "ArrowLeft" && index > 0) onBack();
      }}
      dim={!rect}
    >
      {spot && (
        <div
          aria-hidden
          data-testid="tour-spotlight"
          className="tour-spot pointer-events-none fixed rounded-card"
          style={{ top: spot.top, left: spot.left, width: spot.right - spot.left, height: spot.bottom - spot.top }}
        />
      )}
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        key={step.id}
        className="anim-pop tour-card fixed rounded-card border border-border bg-surface p-5 shadow-pop"
        style={{ top: pos.top, left: pos.left, width: Math.min(CARD_WIDTH, vp.width - 24) }}
      >
        <div className="flex items-center justify-between">
          <p className="text-[11.5px] font-medium text-muted tabular-nums">
            Step {index + 1} of {total}
          </p>
          <button type="button" onClick={onSkip} aria-label="Skip the tour" className="-mr-1.5 rounded-md p-1 text-muted transition-colors hover:bg-hover hover:text-fg">
            <X className="size-4" />
          </button>
        </div>
        <h2 id="tour-title" className="mt-1.5 text-[15.5px] font-semibold tracking-[-0.01em] text-fg">
          {step.title}
        </h2>
        <p id="tour-body" className="mt-1.5 text-[13.5px] leading-relaxed text-muted-strong">
          {step.body}
        </p>
        <div className="mt-4 flex items-center gap-2">
          <Progress index={index} total={total} />
          <div className="ml-auto flex gap-1.5">
            {!last && (
              <Button variant="ghost" size="sm" onClick={onSkip}>
                Skip tour
              </Button>
            )}
            {index > 0 && (
              <Button size="sm" onClick={onBack} aria-label="Previous step">
                <ArrowLeft className="size-3.5" aria-hidden />
              </Button>
            )}
            <Button ref={nextRef} variant="primary" size="sm" onClick={onNext}>
              {last ? "Finish" : "Next"}
              {!last && <ArrowRight className="size-3.5" aria-hidden />}
            </Button>
          </div>
        </div>
      </div>
    </Layer>
  );
}

function Progress({ index, total }: { index: number; total: number }) {
  return (
    <div className="flex gap-1" aria-hidden>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={cx("h-1.5 rounded-full transition-[width,background] duration-200", i === index ? "w-4 bg-accent" : i < index ? "w-1.5 bg-accent/50" : "w-1.5 bg-border-strong")} />
      ))}
    </div>
  );
}

/** Full-window layer: blocks clicks on the app, keeps focus inside, Escape skips. */
function Layer({ children, onEscape, onKey, dim }: { children: ReactNode; onEscape: () => void; onKey?: (e: KeyboardEvent) => void; dim?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const escape = useRef(onEscape);
  const key = useRef(onKey);
  escape.current = onEscape;
  key.current = onKey;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        escape.current();
        return;
      }
      if (e.key === "Tab" && ref.current) {
        const items = Array.from(ref.current.querySelectorAll<HTMLElement>("button:not([disabled])"));
        if (!items.length) return;
        const first = items[0]!;
        const lastItem = items[items.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          lastItem.focus();
        } else if (!e.shiftKey && document.activeElement === lastItem) {
          e.preventDefault();
          first.focus();
        } else if (!ref.current.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        }
        return;
      }
      // Arrow keys step through, unless a button inside wants them.
      key.current?.(e);
    };
    window.addEventListener("keydown", on, true);
    return () => {
      window.removeEventListener("keydown", on, true);
      previous?.focus?.();
    };
  }, []);

  return createPortal(
    <div ref={ref} className="fixed inset-0 z-[70]" data-testid="tour-layer">
      <div className={cx("absolute inset-0", dim && "anim-fade bg-[var(--overlay)]")} />
      {children}
    </div>,
    document.body,
  );
}

/**
 * The browser preview sizes text with CSS `zoom` on <html>: measured rects come back in screen pixels
 * while `top`/`left` are scaled by the zoom. Dividing by it puts both in the same units. (The desktop
 * app zooms the whole webview instead, so this is 1 there.)
 */
function pageZoom(): number {
  const z = parseFloat(getComputedStyle(document.documentElement).zoom);
  return Number.isFinite(z) && z > 0 ? z : 1;
}

/** The target's place on screen, kept up to date while the screen behind it settles or resizes. */
function useTargetRect(target: string | undefined): Box | null {
  const [rect, setRect] = useState<Box | null>(null);
  useEffect(() => {
    if (!target) {
      setRect(null);
      return;
    }
    let frame = 0;
    let prev = "";
    const measure = () => {
      const el = document.querySelector<HTMLElement>(`[data-tour="${target}"]`);
      const r = el?.getBoundingClientRect();
      const z = pageZoom();
      const box = r && r.width > 0 && r.height > 0 ? { top: r.top / z, left: r.left / z, width: r.width / z, height: r.height / z } : null;
      const sig = box ? `${Math.round(box.top)},${Math.round(box.left)},${Math.round(box.width)},${Math.round(box.height)}` : "";
      if (sig !== prev) {
        prev = sig;
        if (box) el?.scrollIntoView?.({ block: "nearest" });
        setRect(box);
      }
      frame = requestAnimationFrame(measure);
    };
    measure();
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return rect;
}
