// Collection colours: an 8-colour palette (CSS vars --c0…--c7, light and dark variants).
// A collection's colour is its position in the sorted collection list, so a small library
// never has two subjects in the same colour.
export const PALETTE_SIZE = 8;

export function colorIndex(name: string | null | undefined, ordered: string[]): number {
  if (!name) return -1;
  const i = ordered.indexOf(name);
  if (i >= 0) return i % PALETTE_SIZE;
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % PALETTE_SIZE;
}

export function colorVar(name: string | null | undefined, ordered: string[]): string {
  const i = colorIndex(name, ordered);
  return i < 0 ? "var(--c-none)" : `var(--c${i})`;
}

/** Resolve the palette to concrete colours (for canvas drawing). */
export function readPalette(el: HTMLElement = document.documentElement): { slots: string[]; none: string } {
  const cs = getComputedStyle(el);
  const get = (n: string, fallback: string) => cs.getPropertyValue(n).trim() || fallback;
  const fallbacks = ["#2563eb", "#059669", "#c2410c", "#e11d48", "#0891b2", "#b45309", "#db2777", "#4d7c0f"];
  return {
    slots: fallbacks.map((f, i) => get(`--c${i}`, f)),
    none: get("--c-none", "#78716c"),
  };
}
