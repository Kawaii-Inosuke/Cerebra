import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Job, SourcesList } from "../api";
import { createFakeApi, defaultSettings, emptySources } from "../test/fakeApi";
import { renderApp } from "../test/render";
import { Agents } from "./Agents";

const job = (over: Partial<Job>): Job => ({
  id: "j1",
  kind: "connect_note",
  target: "Biology/Cell.md",
  status: "queued",
  progress: null,
  error: null,
  origin: "user",
  created_at: "2026-11-26T10:00:00Z",
  started_at: null,
  finished_at: null,
  attempts: 0,
  ...over,
});

const withSource: SourcesList = {
  ...emptySources,
  sources: [{ id: "g1", label: "Gemini", provider: "gemini", model: "m", base_url: null, enabled: true, caps: {}, local: false, has_key: true }],
};

describe("Agents", () => {
  it("shows the queue with stages, live progress, cancel and plain-language failures", async () => {
    const jobCancel = vi.fn(async () => ({}));
    const api = createFakeApi({
      sourcesList: vi.fn(async () => withSource),
      jobCancel,
      jobsList: vi.fn(async () => [
        job({ id: "j1", status: "running", progress: { stage: "reading", done: 1, total: 12 } }),
        job({ id: "j2", kind: "connect_collection", target: "Physics" }),
        job({ id: "j3", status: "failed", error: "HTTP 401 Unauthorized: invalid api key" }),
      ]),
    });
    renderApp(<Agents />, api);

    const running = await screen.findByTestId("job-j1");
    expect(within(running).getByText("Cell")).toBeInTheDocument();
    expect(within(running).getByText("1 of 12")).toBeInTheDocument();
    act(() => api.emit("job-progress", { job_id: "j1", stage: "linking", done: 3, total: 12 }));
    expect(within(running).getByText("3 of 12")).toBeInTheDocument();
    expect(within(running).getByText("linking")).toHaveAttribute("aria-current", "step");
    expect(screen.getByText("Connecting 3 of 12")).toBeInTheDocument();

    expect(screen.getByText("the Physics collection")).toBeInTheDocument();
    expect(screen.getByText(/rejected its key/)).toBeInTheDocument();
    expect(screen.queryByText(/HTTP 401/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel Cell" }));
    await waitFor(() => expect(jobCancel).toHaveBeenCalledWith("j1"));
  });

  it("estimates Connect everything, then queues every collection", async () => {
    const jobEnqueue = vi.fn(async () => ({ id: "x" }));
    renderApp(<Agents />, createFakeApi({ sourcesList: vi.fn(async () => withSource), jobEnqueue }));
    await screen.findByText("Nothing to do right now");
    fireEvent.click(screen.getByRole("button", { name: /Connect everything/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("2 collections with 4 notes");
    expect(dialog).toHaveTextContent("about 16 AI calls");
    fireEvent.click(within(dialog).getByRole("button", { name: "Queue 2 collections" }));
    await waitFor(() => expect(jobEnqueue).toHaveBeenCalledTimes(2));
    expect(jobEnqueue).toHaveBeenCalledWith("connect_collection", "Biology");
    expect(jobEnqueue).toHaveBeenCalledWith("connect_collection", "Physics");
  });

  it("pauses, and saves settings including local-only collections", async () => {
    const agentsSettingsSet = vi.fn(async (s) => s);
    renderApp(<Agents />, createFakeApi({ sourcesList: vi.fn(async () => withSource), agentsSettingsSet }));
    fireEvent.click(await screen.findByRole("button", { name: /Pause all/ }));
    await waitFor(() => expect(agentsSettingsSet).toHaveBeenLastCalledWith({ ...defaultSettings, paused: true }));
    expect(await screen.findByRole("button", { name: /Resume/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Strict" }));
    await waitFor(() => expect(agentsSettingsSet).toHaveBeenLastCalledWith(expect.objectContaining({ threshold: "strict" })));
    fireEvent.click(within(screen.getByRole("group", { name: "Local-only collections" })).getByRole("button", { name: /Biology/ }));
    await waitFor(() => expect(agentsSettingsSet).toHaveBeenLastCalledWith(expect.objectContaining({ local_only: ["Biology"] })));
    expect(screen.getByText(/only sent to AI running on this computer/)).toBeInTheDocument();
  });
});
