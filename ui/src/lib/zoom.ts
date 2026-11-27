// Text size = real webview zoom (desktop) or CSS zoom (browser preview). Font sizes in CSS never change.
export const ZOOM_STEPS = [0.9, 1.0, 1.15, 1.3, 1.45] as const;
export const DEFAULT_ZOOM = 1.15;
export const ZOOM_KEY = "cerebra.zoom";

export function clampZoom(z: number): number {
  return Math.min(1.6, Math.max(0.8, Math.round(z * 100) / 100));
}

/** Index of the step closest to `z`. */
export function nearestStep(z: number): number {
  let best = 0;
  ZOOM_STEPS.forEach((s, i) => {
    if (Math.abs(s - z) < Math.abs(ZOOM_STEPS[best]! - z)) best = i;
  });
  return best;
}

export function stepZoom(z: number, dir: 1 | -1): number {
  const i = nearestStep(z);
  return ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, i + dir))]!;
}

export function zoomLabel(z: number): string {
  return `${Math.round(z * 100)}%`;
}

/** Ctrl/Cmd + = / + zooms in, − zooms out, 0 resets. Returns the action or null. */
export function zoomKey(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">): "in" | "out" | "reset" | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  if (e.key === "=" || e.key === "+") return "in";
  if (e.key === "-" || e.key === "_") return "out";
  if (e.key === "0") return "reset";
  return null;
}

/** Browser preview: emulate webview zoom with CSS zoom on <html>. */
export function applyCssZoom(z: number, root: HTMLElement = document.documentElement) {
  root.style.setProperty("zoom", String(z));
}
