import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { planDrop } from "../lib/drop";
import { ShareProvider } from "../share";
import { createFakeApi } from "../test/fakeApi";
import { renderApp } from "../test/render";
import { Sidebar } from "./Sidebar";
import { DesktopDrop } from "./DesktopDrop";

describe("planDrop", () => {
  const base = { current: null, fallback: null, inbox: "Inbox" };

  it("splits share files from uploads", () => {
    const p = planDrop(["/a/Bio.cerebra", "/a/unit3.pdf", "/a/B.CEREBRA", "/a/notes.md"], base);
    expect(p.shares).toEqual(["/a/Bio.cerebra", "/a/B.CEREBRA"]);
    expect(p.uploads).toEqual(["/a/unit3.pdf", "/a/notes.md"]);
  });

  it("prefers the collection under the pointer, then the current one, then Inbox", () => {
    const target = document.createElement("a");
    target.dataset.dropCollection = "Physics";
    const inner = document.createElement("span");
    target.appendChild(inner);
    expect(planDrop(["/x.pdf"], { ...base, current: "Biology", at: { x: 1, y: 1 }, elementAt: () => inner }).collection).toBe("Physics");
    expect(planDrop(["/x.pdf"], { ...base, current: "Biology", at: { x: 1, y: 1 }, elementAt: () => document.body }).collection).toBe("Biology");
    expect(planDrop(["/x.pdf"], base).collection).toBe("Inbox");
  });
});

describe("desktop drop", () => {
  function setup() {
    let drop: ((paths: string[], at?: { x: number; y: number }) => void) | null = null;
    const api = createFakeApi({
      onFileDrop: vi.fn((cb) => {
        drop = cb;
        return () => {};
      }),
    });
    (api as { desktop: boolean }).desktop = true;
    renderApp(
      <ShareProvider>
        <Sidebar route={{ name: "home" }} />
        <DesktopDrop current="Biology" />
      </ShareProvider>,
      api,
    );
    return { api, drop: (paths: string[], at?: { x: number; y: number }) => act(() => drop!(paths, at)) };
  }

  it("uploads paths to the current collection and opens .cerebra files in the import preview", async () => {
    const { api, drop } = setup();
    await screen.findByTestId("collection-Physics");
    drop(["/home/me/unit3.pdf", "/home/me/Shared.cerebra"]);
    await waitFor(() => expect(api.uploadPaths).toHaveBeenCalledWith("Biology", ["/home/me/unit3.pdf"]));
    await waitFor(() => expect(api.shareInspect).toHaveBeenCalledWith("/home/me/Shared.cerebra", undefined));
    expect(await screen.findByText("Added unit3.pdf")).toBeInTheDocument();
  });

  it("uses the sidebar collection under the pointer and shows a toast per error", async () => {
    const { api, drop } = setup();
    const physics = await screen.findByTestId("collection-Physics");
    const orig = document.elementFromPoint;
    document.elementFromPoint = () => physics;
    vi.mocked(api.uploadPaths).mockResolvedValueOnce([
      { name: "a.pdf", note_id: "n_a" },
      { name: "huge.mp4", error: "huge.mp4 is larger than 25 MB" },
    ]);
    drop(["/a.pdf", "/huge.mp4"], { x: 20, y: 300 });
    await waitFor(() => expect(api.uploadPaths).toHaveBeenCalledWith("Physics", ["/a.pdf", "/huge.mp4"]));
    expect(await screen.findByText("Couldn't add huge.mp4")).toBeInTheDocument();
    expect(screen.getByText("huge.mp4 is larger than 25 MB")).toBeInTheDocument();
    expect(screen.getByText("Added a.pdf")).toBeInTheDocument();
    document.elementFromPoint = orig;
  });
});
