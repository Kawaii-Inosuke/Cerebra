// The guided tour's steps, where its card goes, and whether it has been seen.
import type { Route } from "./router";
import { modKey } from "./util";

export interface TourStep {
  id: string;
  /** `data-tour` value of the element to point at; none = a centred card. */
  target?: string;
  /** Screen to show behind the step. */
  route?: Route;
  title: string;
  body: string;
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: "library",
    target: "library",
    route: { name: "home" },
    title: "This is your library",
    body: "Everything lives in one ordinary folder on your computer. Switch between libraries or make a new one from here.",
  },
  {
    id: "add",
    target: "add",
    route: { name: "home" },
    title: "Add your material",
    body: "Upload PDFs, Word files, slides or scans, write a note, or import a folder of notes you already have. You can also drop files anywhere in the window.",
  },
  {
    id: "collections",
    target: "collections",
    route: { name: "home" },
    title: "Collections",
    body: "A collection holds one subject, course or project. Drop files onto a collection to add them straight to it.",
  },
  {
    id: "graph",
    target: "graph",
    route: { name: "graph" },
    title: "See how ideas connect",
    body: "The graph shows how your notes link to each other. Violet arrows are connections the AI found, labelled with how the notes relate. Click one to see why.",
  },
  {
    id: "ai-sources",
    target: "ai-sources",
    route: { name: "ai-sources" },
    title: "Add an AI",
    body: "Paste a free key from Gemini or Groq, or use a model on your own computer. If one key hits its limit, the next one takes over. Keys stay in your system's keychain.",
  },
  {
    id: "agents",
    target: "agents",
    route: { name: "agents" },
    title: "The agents",
    body: "They read your material and save only connections worth keeping, each with a reason and quotes from both notes. Follow their progress and set limits here.",
  },
  {
    id: "review",
    target: "review",
    route: { name: "review" },
    title: "Review what the AI found",
    body: "New connections wait here. Keep the good ones and reject the rest. AI never edits your own notes.",
  },
  {
    id: "connect-ai",
    target: "connect-ai",
    route: { name: "connect-ai" },
    title: "Use your notes from Claude or Codex",
    body: "Connect Claude Desktop, Claude Code, Codex or Cursor in one click, then ask questions that cite your own notes.",
  },
  {
    id: "palette",
    target: "palette",
    title: "Search or do anything",
    body: `Press ${modKey} K to search your notes by meaning or run any command, from anywhere in the app.`,
  },
  {
    id: "done",
    target: "settings",
    title: "You're all set",
    body: "Theme, text size and models are in Settings. You can take this tour again any time from Settings → Help.",
  },
];

// ---------- Seen or not ----------

export const TOUR_KEY = "cerebra.tour";
export type TourOutcome = "done" | "skipped";

export function tourSeen(storage: Pick<Storage, "getItem"> | null = safeStorage()): boolean {
  try {
    const v = storage?.getItem(TOUR_KEY);
    return v === "done" || v === "skipped";
  } catch {
    // No storage: don't nag on every start.
    return true;
  }
}

export function markTour(outcome: TourOutcome, storage: Pick<Storage, "setItem"> | null = safeStorage()) {
  try {
    storage?.setItem(TOUR_KEY, outcome);
  } catch {
    /* ignore */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

// ---------- Placement ----------

export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

export type Side = "right" | "bottom" | "top" | "center";

/**
 * Where the card goes: to the right of things in the sidebar, otherwise below (or above when
 * there's no room), always kept inside the window with `margin` to spare.
 */
export function placeCard(
  target: Box | null,
  card: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 14,
  margin = 12,
): { top: number; left: number; side: Side } {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
  const maxLeft = viewport.width - card.width - margin;
  const maxTop = viewport.height - card.height - margin;
  if (!target || target.width === 0 || target.height === 0) {
    return { top: clamp((viewport.height - card.height) / 2, margin, maxTop), left: clamp((viewport.width - card.width) / 2, margin, maxLeft), side: "center" };
  }
  const right = target.left + target.width;
  const bottom = target.top + target.height;
  if (right + gap + card.width + margin <= viewport.width && target.left < viewport.width / 3) {
    return { top: clamp(target.top + target.height / 2 - card.height / 2, margin, maxTop), left: right + gap, side: "right" };
  }
  const left = clamp(target.left + target.width / 2 - card.width / 2, margin, maxLeft);
  if (bottom + gap + card.height + margin <= viewport.height) return { top: bottom + gap, left, side: "bottom" };
  if (target.top - gap - card.height >= margin) return { top: target.top - gap - card.height, left, side: "top" };
  return { top: clamp(bottom + gap, margin, maxTop), left, side: "bottom" };
}
