import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { createFakeApi, makeNote } from "../test/fakeApi";
import { renderApp } from "../test/render";
import { NoteView } from "./NoteView";

describe("NoteView", () => {
  it("renders the note html and its backlinks", async () => {
    const api = createFakeApi({ getNote: vi.fn(async () => makeNote()) });
    renderApp(<NoteView id="n_cell" />, api);
    const article = await screen.findByRole("article");
    expect(within(article).getByRole("heading", { name: "Cell" })).toBeInTheDocument();
    expect(within(article).getByRole("link", { name: "Membrane" })).toBeInTheDocument();

    const panel = screen.getByRole("complementary", { name: "Note details" });
    expect(within(panel).getByText("DNA")).toBeInTheDocument();
    expect(within(panel).getByText(/nucleus/)).toBeInTheDocument();
    expect(within(panel).getByText(/No AI connections yet/)).toBeInTheDocument();
  });

  it("navigates when a cerebra:// note link is clicked", async () => {
    renderApp(<NoteView id="n_cell" />, createFakeApi());
    const article = await screen.findByRole("article");
    fireEvent.click(within(article).getByRole("link", { name: "Membrane" }));
    expect(location.hash).toBe("#/note/n_mem");
  });

  it("edits and saves through save_note", async () => {
    const saved = makeNote({ text: "# Cell\n\nUpdated text.", html: "<h1>Cell</h1><p>Updated text.</p>" });
    const saveNote = vi.fn(async () => saved);
    const api = createFakeApi({ getNote: vi.fn(async () => makeNote()), saveNote });
    renderApp(<NoteView id="n_cell" />, api);

    fireEvent.click(await screen.findByRole("button", { name: /Edit/ }));
    const host = await screen.findByTestId("editor");
    const view = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
    expect(view.state.doc.toString()).toBe("# Cell\n\nA cell has a [[Membrane]].");
    act(() => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "# Cell\n\nUpdated text." } });
    });
    expect(screen.getByText(/Unsaved changes/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(saveNote).toHaveBeenCalledWith("n_cell", "# Cell\n\nUpdated text."));
    expect(await screen.findByText("Updated text.")).toBeInTheDocument();
    expect(screen.queryByTestId("editor")).not.toBeInTheDocument();
  });

  it("saves with Ctrl+S", async () => {
    const saveNote = vi.fn(async (id: string, text: string) => makeNote({ id, text }));
    renderApp(<NoteView id="n_cell" startEditing />, createFakeApi({ saveNote }));
    await screen.findByTestId("editor");
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => expect(saveNote).toHaveBeenCalledTimes(1));
  });

  it("explains a missing note in plain words", async () => {
    renderApp(<NoteView id="gone" />, createFakeApi({ getNote: vi.fn(async () => Promise.reject(new Error("note not found"))) }));
    expect(await screen.findByText("This note couldn't be opened")).toBeInTheDocument();
    expect(screen.getByText(/moved, renamed or deleted/)).toBeInTheDocument();
  });
});

describe("NoteView AI connections", () => {
  const ai = [
    {
      id: "c1",
      other_id: "n_osmosis",
      other_title: "Osmosis",
      other_path: "Biology/Osmosis.md",
      direction: "out" as const,
      type: "example_of",
      reason: "Roots taking in water is an example of osmosis.",
      evidence: [{ note: "Biology/Cell.md", quote: "Plant roots take in water" }],
      confidence: 0.9,
      status: "suggested" as const,
      made_by: { kind: "agent", source: "groq:llama" },
      created_at: "2026-11-26T10:00:00Z",
    },
    {
      id: "c2",
      other_id: "n_dna",
      other_title: "DNA",
      other_path: "Biology/DNA.md",
      direction: "in" as const,
      type: "builds_on",
      reason: "Builds on the nucleus idea.",
      evidence: [],
      confidence: 0.7,
      status: "kept" as const,
      made_by: { kind: "agent" },
      created_at: "2026-11-26T10:00:00Z",
    },
  ];

  it("groups by type and keeps / dismisses through ai_set_status", async () => {
    const aiSetStatus = vi.fn(async (ids: string[]) => ({ changed: ids.length }));
    renderApp(<NoteView id="n_cell" />, createFakeApi({ aiSetStatus, getNote: vi.fn(async () => makeNote({ ai_connections: ai })) }));
    const panel = await screen.findByRole("complementary", { name: "Note details" });
    expect(within(panel).getByText("example of")).toBeInTheDocument();
    expect(within(panel).getByText("builds on")).toBeInTheDocument();
    expect(within(panel).getByText("Roots taking in water is an example of osmosis.")).toBeInTheDocument();
    expect(within(panel).getByText("Show quotes")).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "Keep connection to Osmosis" }));
    await waitFor(() => expect(aiSetStatus).toHaveBeenCalledWith(["c1"], "kept"));
    expect(within(screen.getByTestId("ai-c1")).getByText("kept")).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "Dismiss connection to DNA" }));
    await waitFor(() => expect(aiSetStatus).toHaveBeenCalledWith(["c2"], "dismissed"));
    expect(screen.queryByTestId("ai-c2")).not.toBeInTheDocument();
  });

  it("queues Connect this note", async () => {
    const jobEnqueue = vi.fn(async () => ({ id: "j9" }));
    renderApp(<NoteView id="n_cell" />, createFakeApi({ jobEnqueue }));
    fireEvent.click((await screen.findAllByRole("button", { name: /Connect this note/ }))[0]!);
    await waitFor(() => expect(jobEnqueue).toHaveBeenCalledWith("connect_note", "Biology/Cell.md"));
  });
});
