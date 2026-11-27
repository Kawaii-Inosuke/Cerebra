import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTheme, loadThemePref, resolveTheme, saveThemePref } from "./lib/theme";

function mockSystem(dark: boolean) {
  window.matchMedia = vi.fn((q: string) => ({
    matches: dark && q.includes("dark"),
    media: q,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

describe("theme", () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme;
  });

  it("light and dark set data-theme directly", () => {
    mockSystem(true);
    expect(applyTheme("light")).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("system follows prefers-color-scheme", () => {
    mockSystem(true);
    applyTheme("system");
    expect(document.documentElement.dataset.theme).toBe("dark");
    mockSystem(false);
    applyTheme("system");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("resolves without touching the DOM", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("defaults to system and remembers the choice", () => {
    expect(loadThemePref()).toBe("system");
    saveThemePref("dark");
    expect(loadThemePref()).toBe("dark");
  });
});
