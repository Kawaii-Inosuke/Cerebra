// When to show the "new version" window, and what the person chose last time.

export type UpdateMode = "store" | "in_place" | "download_page";

export interface UpdateInfo {
  /** The new version, e.g. "0.1.2". */
  version: string;
  /** The version running now. */
  current?: string | null;
  /** Release notes (GitHub installs); null for Store installs. */
  notes?: string | null;
  /** How this copy updates: through the Microsoft Store, in place, or from the download page. */
  mode: UpdateMode;
}

export const AUTO_KEY = "cerebra.updates.auto";
export const SNOOZE_KEY = "cerebra.updates.snooze";
/** "Later" waits this long before asking again. */
export const LATER_MS = 24 * 60 * 60 * 1000;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Check for updates when Cerebra starts (on unless turned off in Settings). */
export function autoCheck(s: Pick<Storage, "getItem"> | null = storage()): boolean {
  try {
    return s?.getItem(AUTO_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setAutoCheck(on: boolean, s: Pick<Storage, "setItem"> | null = storage()) {
  try {
    s?.setItem(AUTO_KEY, on ? "on" : "off");
  } catch {
    /* ignore */
  }
}

/** "Later": don't ask about this version again for a day. */
export function remindLater(version: string, now = Date.now(), s: Pick<Storage, "setItem"> | null = storage()) {
  try {
    s?.setItem(SNOOZE_KEY, JSON.stringify({ version, until: now + LATER_MS }));
  } catch {
    /* ignore */
  }
}

/** Was "Later" chosen for this version less than a day ago? A newer version asks again straight away. */
export function snoozed(version: string, now = Date.now(), s: Pick<Storage, "getItem"> | null = storage()): boolean {
  try {
    const v = JSON.parse(s?.getItem(SNOOZE_KEY) ?? "null") as { version?: string; until?: number } | null;
    return !!v && v.version === version && typeof v.until === "number" && now < v.until;
  } catch {
    return false;
  }
}

/** Release notes as short plain text: the GitHub release body without Markdown clutter. */
export function plainNotes(notes: string | null | undefined, max = 600): string {
  if (!notes) return "";
  const text = notes
    .replace(/\r\n/g, "\n")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
