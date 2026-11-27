// Facts about the app itself: version, links, and the details a bug report needs.
// The version is never typed in by hand: the build injects it from package.json, and the desktop
// app asks Tauri (which reads tauri.conf.json). scripts/bump-version.mjs keeps those equal.

declare const __APP_VERSION__: string;

export const BUILD_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";

export const REPO_URL = "https://github.com/Kawaii-Inosuke/Cerebra";

export const LINKS = {
  repo: REPO_URL,
  releases: `${REPO_URL}/releases`,
  latest: `${REPO_URL}/releases/latest`,
  docs: `${REPO_URL}/tree/main/docs#readme`,
  issues: `${REPO_URL}/issues`,
} as const;

/** The running app's version: Tauri's in the desktop app, the build's in the browser preview. */
export async function appVersion(desktop: boolean): Promise<string> {
  if (!desktop) return BUILD_VERSION;
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return BUILD_VERSION;
  }
}

/** "Windows", "macOS", "Linux"… from the browser's own description of the system. */
export function osName(ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent): string {
  if (/Windows/i.test(ua)) return "Windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macOS";
  if (/Android/i.test(ua)) return "Android";
  if (/Linux|X11/i.test(ua)) return "Linux";
  return "Unknown";
}

/** Model status words for the bug report. */
export const BUGREPORT_MODELS: Record<string, string> = {
  ready: "ready",
  missing: "not downloaded",
  downloading: "downloading",
  unavailable: "not available",
};

export interface BugReportFacts {
  version: string;
  os: string;
  desktop: boolean;
  models: string;
  /** e.g. "2 AI sources, 1 job running". Counts only: never keys, names of notes, or note text. */
  agents: string;
}

/** Plain text for "Copy details for a bug report". Only the facts passed in; nothing private. */
export function bugReportText(f: BugReportFacts): string {
  return [
    `Cerebra ${f.version}`,
    `System: ${f.os}`,
    `Build: ${f.desktop ? "desktop app" : "browser preview"}`,
    `Search and OCR models: ${f.models}`,
    `Agents: ${f.agents}`,
  ].join("\n");
}

/** A new GitHub issue with the details filled in; the person writes the rest. */
export function newIssueUrl(details: string): string {
  const body = `**What happened?**\n\n\n**What did you expect?**\n\n\n**Steps to see it again**\n1. \n\n---\n${details}\n`;
  return `${LINKS.issues}/new?${new URLSearchParams({ body }).toString()}`;
}
