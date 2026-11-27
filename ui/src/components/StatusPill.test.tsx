import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Job, SourcesList } from "../api";
import { clockTime, computePill } from "../lib/ai";
import { createFakeApi, defaultSettings, emptySources } from "../test/fakeApi";
import { renderApp } from "../test/render";
import { StatusPill } from "./StatusPill";

const src = (enabled = true): SourcesList => ({
  ...emptySources,
  sources: [{ id: "g1", label: "Gemini", provider: "gemini", model: "m", base_url: null, enabled, caps: {}, local: false, has_key: true }],
});
const running: Job = { id: "j1", kind: "connect_note", target: "a.md", status: "running", progress: { stage: "reading", done: 3, total: 12 }, error: null, origin: "user", created_at: "", started_at: "", finished_at: null, attempts: 1 };

describe("status pill", () => {
  const base = { settings: defaultSettings, jobs: [] as Job[], progress: {}, statuses: {}, now: Date.now() };

  it("computes every state", () => {
    expect(computePill({ ...base, sources: emptySources }).label).toBe("No AI source");
    expect(computePill({ ...base, sources: src(false) }).label).toBe("No AI source");
    expect(computePill({ ...base, sources: src() }).label).toBe("Idle");
    expect(computePill({ ...base, sources: src(), jobs: [running] }).label).toBe("Connecting 3 of 12");
    expect(computePill({ ...base, sources: src(), settings: { ...defaultSettings, paused: true }, jobs: [running] }).label).toBe("Paused");
    const until = Date.now() + 30 * 60_000;
    expect(computePill({ ...base, sources: src(), jobs: [running], statuses: { g1: { state: "cooling", until: new Date(until).toISOString() } } }).label).toBe(`Resting until ${clockTime(until)}`);
  });

  it("starts at No AI source and follows live events", async () => {
    const sourcesList = vi.fn(async () => emptySources);
    const api = createFakeApi({ sourcesList });
    renderApp(<StatusPill />, api);
    expect(await screen.findByText("No AI source")).toBeInTheDocument();
    expect(screen.getByTestId("status-pill")).toBeInTheDocument();
  });

  it("shows Connecting from jobs and progress events", async () => {
    const api = createFakeApi({ sourcesList: vi.fn(async () => src()), jobsList: vi.fn(async () => [running]) });
    renderApp(<StatusPill />, api);
    expect(await screen.findByText("Connecting 3 of 12")).toBeInTheDocument();
    act(() => api.emit("job-progress", { job_id: "j1", stage: "judging", done: 9, total: 12 }));
    await waitFor(() => expect(screen.getByText("Connecting 9 of 12")).toBeInTheDocument());
  });

  it("shows Resting until when every source is cooling", async () => {
    const until = Date.now() + 10 * 60_000;
    const api = createFakeApi({ sourcesList: vi.fn(async () => src()) });
    renderApp(<StatusPill />, api);
    expect(await screen.findByText("Idle")).toBeInTheDocument();
    act(() => api.emit("source-status", { source_id: "g1", state: "cooling", until: Math.floor(until / 1000), reason: "429" }));
    expect(await screen.findByText(`Resting until ${clockTime(until)}`)).toBeInTheDocument();
  });

  it("shows Paused from the settings", async () => {
    renderApp(<StatusPill />, createFakeApi({ sourcesList: vi.fn(async () => src()), agentsSettingsGet: vi.fn(async () => ({ ...defaultSettings, paused: true })) }));
    expect(await screen.findByText("Paused")).toBeInTheDocument();
  });
});
