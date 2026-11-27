import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SourcesList } from "../api";
import { createFakeApi, emptySources } from "../test/fakeApi";
import { renderApp } from "../test/render";
import { AISources } from "./AISources";

describe("AI sources", () => {
  it("adds a source from a preset, tests it, and never shows the key", async () => {
    const sourceAdd = vi.fn(async () => ({ id: "gemini-1", label: "Google Gemini", provider: "gemini", model: "gemini-2.5-flash", base_url: null, enabled: true, caps: {}, local: false, has_key: true }));
    const sourceTest = vi.fn(async () => ({ ok: true, latency_ms: 321, model: "gemini-2.5-flash" }));
    const api = createFakeApi({ sourceAdd, sourceTest });
    renderApp(<AISources />, api);

    expect(await screen.findByText("No AI source yet")).toBeInTheDocument();
    expect(screen.getByText("When one is busy or out of quota, the next one takes over.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add your first source" }));

    const grid = screen.getByRole("list", { name: "AI providers" });
    const gemini = within(grid).getByRole("button", { name: /Google Gemini/ });
    expect(gemini).toHaveTextContent("free");
    expect(within(grid).getAllByRole("link", { name: /Get a free key/ })[0]).toHaveAttribute("href", "https://aistudio.google.com/apikey");
    expect(within(grid).getByRole("button", { name: /OpenAI/ })).not.toHaveTextContent("free");

    fireEvent.click(gemini);
    const user = userEvent.setup();
    const key = screen.getByPlaceholderText("Paste the key here");
    expect(key).toHaveAttribute("type", "password");
    await user.type(key, "AIzaSECRETVALUE1234");
    expect(screen.getByText("Ends in ••••1234")).toBeInTheDocument();
    expect(screen.queryByText(/SECRETVALUE/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add and test" }));
    await waitFor(() => expect(sourceAdd).toHaveBeenCalledWith(expect.objectContaining({ provider: "gemini", model: "gemini-2.5-flash" }), "AIzaSECRETVALUE1234"));
    await waitFor(() => expect(sourceTest).toHaveBeenCalledWith("gemini-1"));
  });

  it("shows status, usage and key state, and asks before removing", async () => {
    const until = new Date(Date.now() + 58_000).toISOString();
    const list: SourcesList = {
      ...emptySources,
      sources: [
        { id: "g1", label: "Gemini", provider: "gemini", model: "gemini-2.5-flash", base_url: null, enabled: true, caps: { requests_per_day: 100 }, local: false, has_key: true },
        { id: "o1", label: "Ollama", provider: "ollama", model: "llama3.1:8b", base_url: "http://localhost:11434", enabled: true, caps: {}, local: true, has_key: false },
      ],
      usage: [{ source_id: "g1", requests: 42, input_tokens: 1000, output_tokens: 200 }],
      statuses: { g1: { state: "cooling", until, reason: "429" }, o1: { state: "disabled", reason: "Ollama isn't running" } },
    };
    const sourceRemove = vi.fn(async () => null);
    const sourceReorder = vi.fn(async () => null);
    renderApp(<AISources />, createFakeApi({ sourcesList: vi.fn(async () => list), sourceRemove, sourceReorder }));

    const g = await screen.findByTestId("source-g1");
    expect(within(g).getByText(/Resting 0:5\d/)).toBeInTheDocument();
    expect(within(g).getByText("Key saved")).toBeInTheDocument();
    expect(within(g).getByText(/42 of 100 requests today/)).toBeInTheDocument();
    const o = screen.getByTestId("source-o1");
    expect(within(o).getByText("Key problem")).toBeInTheDocument();
    expect(within(o).getByText("No key needed")).toBeInTheDocument();

    fireEvent.click(within(o).getByRole("button", { name: "Move up" }));
    await waitFor(() => expect(sourceReorder).toHaveBeenCalledWith(["o1", "g1"]));

    fireEvent.click(within(g).getByRole("button", { name: "Remove Gemini" }));
    expect(sourceRemove).not.toHaveBeenCalled();
    fireEvent.click(within(g).getByRole("button", { name: "Remove Gemini?" }));
    await waitFor(() => expect(sourceRemove).toHaveBeenCalledWith("g1"));
  });

  it("detects local models and adds one", async () => {
    const sourceAdd = vi.fn(async () => ({ id: "ollama-1", label: "Ollama", provider: "ollama", model: "qwen2.5:7b", base_url: null, enabled: true, caps: {}, local: true, has_key: false }));
    renderApp(<AISources />, createFakeApi({ detectLocalModels: vi.fn(async () => ({ ollama: ["qwen2.5:7b"], lmstudio: [] })), sourceAdd }));
    fireEvent.click(await screen.findByRole("button", { name: /Detect local models/ }));
    expect(await screen.findByText("qwen2.5:7b")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(sourceAdd).toHaveBeenCalledWith({ provider: "ollama", model: "qwen2.5:7b", enabled: true }));
  });
});
