import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createFakeApi } from "../test/fakeApi";
import { renderApp } from "../test/render";
import { CommandPalette, cleanSnippet } from "./CommandPalette";

describe("CommandPalette", () => {
  it("opens with Ctrl+K, searches passages, and Enter opens the note", async () => {
    const search = vi.fn(async () => [
      { note_id: "n_force", path: "Physics/Force.md", title: "Force", heading_path: "Force", snippet: "F equals **mass** times acceleration", line: 2, score: 1 },
    ]);
    const api = createFakeApi({ search });
    renderApp(<CommandPalette />, api);
    await waitFor(() => expect(api.listNotes).toHaveBeenCalled());

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = await screen.findByPlaceholderText(/Search notes and passages/);

    const user = userEvent.setup();
    await user.type(input, "mass");
    await waitFor(() => expect(search).toHaveBeenCalledWith("mass", { limit: 8 }));
    expect(await screen.findByText("mass")).toBeInTheDocument();
    expect(screen.getByText("Force")).toBeInTheDocument();

    await user.keyboard("{Enter}");
    await act(() => new Promise((r) => setTimeout(r, 10)));
    expect(location.hash).toBe("#/note/n_force");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("finds notes by title without a server round trip", async () => {
    const api = createFakeApi();
    renderApp(<CommandPalette />, api);
    await waitFor(() => expect(api.listNotes).toHaveBeenCalled());
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const input = await screen.findByPlaceholderText(/Search notes and passages/);
    await userEvent.setup().type(input, "memb");
    expect(await screen.findByText("Membrane")).toBeInTheDocument();
  });

  it("shows wikilinks in snippets as plain words", () => {
    expect(cleanSnippet("see [[Cell Structure#Organelles]] and [[Reaction Rates|rates]]")).toBe("see Cell Structure and rates");
  });
});
