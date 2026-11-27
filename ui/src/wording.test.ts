import { describe, expect, it } from "vitest";

// Every UI source file, as text (tests excluded).
const sources = import.meta.glob(["./**/*.{ts,tsx}", "!./**/*.test.{ts,tsx}", "!./test/**"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;

describe("app wording", () => {
  it("reads the UI sources", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(20);
  });

  it("never mentions other note apps by name", () => {
    const hits = Object.entries(sources)
      .filter(([, text]) => /obsidian/i.test(text))
      .map(([file]) => file);
    expect(hits).toEqual([]);
  });
});
