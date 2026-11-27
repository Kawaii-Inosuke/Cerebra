// Theme: Light / Dark / System (default System). The resolved theme lives on
// <html data-theme="light|dark">; System follows prefers-color-scheme live.
export type ThemePref = "light" | "dark" | "system";
export type Density = "comfortable" | "compact";

const THEME_KEY = "cerebra.theme";
const DENSITY_KEY = "cerebra.density";

function store(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function systemPrefersDark(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveTheme(pref: ThemePref, prefersDark = systemPrefersDark()): "light" | "dark" {
  if (pref === "system") return prefersDark ? "dark" : "light";
  return pref;
}

export function loadThemePref(): ThemePref {
  const v = store()?.getItem(THEME_KEY);
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

export function saveThemePref(pref: ThemePref) {
  store()?.setItem(THEME_KEY, pref);
}

let unwatch: (() => void) | null = null;

/** Apply a theme preference to <html>; with "system", keeps following the OS setting. */
export function applyTheme(pref: ThemePref, root: HTMLElement = document.documentElement): "light" | "dark" {
  unwatch?.();
  unwatch = null;
  const resolved = resolveTheme(pref);
  root.dataset.theme = resolved;
  root.dataset.themePref = pref;
  if (pref === "system" && typeof window.matchMedia === "function") {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => {
      root.dataset.theme = e.matches ? "dark" : "light";
      window.dispatchEvent(new CustomEvent("cerebra-theme", { detail: root.dataset.theme }));
    };
    mq.addEventListener?.("change", onChange);
    unwatch = () => mq.removeEventListener?.("change", onChange);
  }
  window.dispatchEvent(new CustomEvent("cerebra-theme", { detail: resolved }));
  return resolved;
}

export function loadDensity(): Density {
  return store()?.getItem(DENSITY_KEY) === "compact" ? "compact" : "comfortable";
}

export function applyDensity(d: Density, root: HTMLElement = document.documentElement) {
  root.dataset.density = d;
  store()?.setItem(DENSITY_KEY, d);
}
