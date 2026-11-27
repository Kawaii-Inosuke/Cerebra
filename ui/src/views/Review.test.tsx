import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createFakeApi, makeConcept, makeConnection } from "../test/fakeApi";
import { renderApp } from "../test/render";
import { Review } from "./Review";

describe("Review", () => {
  const two = () => [
    makeConnection({ id: "c1", confidence: 0.9 }),
    makeConnection({ id: "c2", from_title: "Leaves", to_title: "Light", type: "explains", reason: "Leaves catch light.", confidence: 0.7, made_by: { kind: "assistant", source: "Claude Desktop" } }),
  ];

  it("shows both titles, type, reason, both quotes, confidence and who made it", async () => {
    renderApp(<Review />, createFakeApi({ aiList: vi.fn(async () => ({ connections: two(), concepts: [] })) }));
    const card = await screen.findByRole("article", { name: /Plants example of Osmosis/ });
    expect(within(card).getByRole("link", { name: "Plants" })).toHaveAttribute("href", "#/note/n_plants");
    expect(within(card).getByRole("link", { name: "Osmosis" })).toHaveAttribute("href", "#/note/n_osmosis");
    expect(within(card).getByText("example of")).toBeInTheDocument();
    expect(within(card).getByText("Roots taking in water is an example of osmosis.")).toBeInTheDocument();
    expect(within(card).getByText("“Plant roots take in water by osmosis”")).toBeInTheDocument();
    expect(within(card).getByText("“Osmosis is water moving across a membrane”")).toBeInTheDocument();
    expect(within(card).getByText("90%")).toBeInTheDocument();
    expect(within(card).getByText("Agent · groq:llama-3.3-70b-versatile")).toBeInTheDocument();
    expect(screen.getByText("AI app · Claude Desktop")).toBeInTheDocument();
  });

  it("K keeps, J moves, D dismisses", async () => {
    const decided = new Set<string>();
    const aiSetStatus = vi.fn(async (ids: string[]) => {
      ids.forEach((i) => decided.add(i));
      return { changed: ids.length };
    });
    const all = [...two(), makeConnection({ id: "c3", from_title: "Roots", confidence: 0.5 })];
    renderApp(<Review />, createFakeApi({ aiSetStatus, aiList: vi.fn(async () => ({ connections: all.filter((c) => !decided.has(c.id)), concepts: [] })) }));
    const first = await screen.findByRole("article", { name: /Plants example of Osmosis/ });
    expect(first).toHaveAttribute("aria-current", "true");

    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => expect(aiSetStatus).toHaveBeenCalledWith(["c1"], "kept"));
    await waitFor(() => expect(screen.queryByRole("article", { name: /Plants example of Osmosis/ })).not.toBeInTheDocument());
    expect(screen.getByRole("article", { name: /Leaves/ })).toHaveAttribute("aria-current", "true");

    fireEvent.keyDown(window, { key: "j" });
    expect(screen.getByRole("article", { name: /Roots/ })).toHaveAttribute("aria-current", "true");
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(screen.getByRole("article", { name: /Leaves/ })).toHaveAttribute("aria-current", "true");

    fireEvent.keyDown(window, { key: "d" });
    await waitFor(() => expect(aiSetStatus).toHaveBeenCalledWith(["c2"], "dismissed"));
  });

  it("bulk keeps everything in the filter after confirming", async () => {
    const aiSetStatus = vi.fn(async (ids: string[]) => ({ changed: ids.length }));
    renderApp(<Review />, createFakeApi({ aiSetStatus, aiList: vi.fn(async () => ({ connections: two(), concepts: [] })) }));
    fireEvent.click(await screen.findByRole("button", { name: "Keep all" }));
    expect(aiSetStatus).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep all 2?" }));
    await waitFor(() => expect(aiSetStatus).toHaveBeenCalledWith(["c1", "c2"], "kept"));
  });

  it("filters by collection", async () => {
    const aiList = vi.fn(async () => ({ connections: two(), concepts: [] }));
    renderApp(<Review />, createFakeApi({ aiList }));
    await screen.findAllByRole("article");
    fireEvent.click(within(screen.getByRole("group", { name: "Collection filter" })).getByRole("button", { name: /Physics/ }));
    await waitFor(() => expect(aiList).toHaveBeenLastCalledWith({ status: "suggested", collection: "Physics" }));
  });

  it("keeps a concept as a real note", async () => {
    const aiPromoteConcept = vi.fn(async () => ({ note_path: "Biology/Water transport.md", note_id: "n_wt" }));
    renderApp(<Review />, createFakeApi({ aiPromoteConcept, aiList: vi.fn(async () => ({ connections: [], concepts: [makeConcept()] })) }));
    const tab = await screen.findByRole("tab", { name: /Concepts/ });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    fireEvent.click(await screen.findByRole("button", { name: "Keep as real note" }));
    await waitFor(() => expect(aiPromoteConcept).toHaveBeenCalledWith("k1"));
  });
});
