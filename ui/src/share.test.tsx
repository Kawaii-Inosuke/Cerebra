import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ExportDialog, ImportDialog } from "./share";
import { createFakeApi } from "./test/fakeApi";
import { renderApp } from "./test/render";

describe("share export", () => {
  it("passes the options and the chosen path (desktop save dialog)", async () => {
    const shareExport = vi.fn(async (o: { path: string }) => ({ path: o.path, bytes: 4096 }));
    const pickSaveFile = vi.fn(async () => "/home/me/Biology");
    const onClose = vi.fn();
    const api = createFakeApi({ shareExport, pickSaveFile });
    (api as { desktop: boolean }).desktop = true;
    renderApp(<ExportDialog collection="Biology" onClose={onClose} />, api);

    fireEvent.click(await screen.findByRole("switch", { name: "Include original files" }));
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("Leave empty for no password"), "s3cret");
    expect(screen.getByText(/no way to recover a forgotten password/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save as…" }));

    await waitFor(() => expect(pickSaveFile).toHaveBeenCalledWith("Biology.cerebra"));
    await waitFor(() =>
      expect(shareExport).toHaveBeenCalledWith({ collection: "Biology", path: "/home/me/Biology.cerebra", include_files: false, include_suggested: true, password: "s3cret" }),
    );
    expect(await screen.findByText("Saved Biology.cerebra")).toBeInTheDocument();
    expect(screen.getByText(/Send it any way you like/)).toBeInTheDocument();
    expect(onClose).toHaveBeenCalled();
  });

  it("asks for a path in the browser preview", async () => {
    const shareExport = vi.fn(async (o: { path: string }) => ({ path: o.path, bytes: 10 }));
    renderApp(<ExportDialog collection="Physics" onClose={() => {}} />, createFakeApi({ shareExport }));
    const user = userEvent.setup();
    await user.type(await screen.findByPlaceholderText("/home/you/Desktop/Physics.cerebra"), "/tmp/out/Physics.cerebra");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(shareExport).toHaveBeenCalledWith(expect.objectContaining({ collection: "Physics", path: "/tmp/out/Physics.cerebra", include_files: true, include_suggested: true })));
  });
});

describe("share import", () => {
  it("asks for the password when needed, previews, renames and imports", async () => {
    const shareInspect = vi
      .fn()
      .mockRejectedValueOnce(new Error("This file needs a password"))
      .mockRejectedValueOnce(new Error("Wrong password"))
      .mockResolvedValueOnce({ title: "Biology", counts: { notes: 12, files: 2, connections: 5, concepts: 1 }, notes: Array.from({ length: 12 }, (_, i) => `notes/Note ${i + 1}.md`), encrypted: true });
    const shareImport = vi.fn(async (_p: string, o?: { collection?: string }) => ({ collection: o?.collection ?? "Biology", notes: 12, files: 2, connections: 5, concepts: 1 }));
    const onClose = vi.fn();
    renderApp(<ImportDialog initialPath="/home/me/Biology.cerebra" onClose={onClose} />, createFakeApi({ shareInspect, shareImport }));

    const pw = await screen.findByLabelText("Password");
    const user = userEvent.setup();
    await user.type(pw, "nope");
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByText(/That password didn't work/)).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Password"));
    await user.type(screen.getByLabelText("Password"), "s3cret");
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));

    expect(await screen.findByText("12 notes · 2 files · 5 connections · 1 concept")).toBeInTheDocument();
    expect(screen.getByText("Note 1")).toBeInTheDocument();
    expect(screen.queryByText("Note 11")).not.toBeInTheDocument();
    expect(screen.getByText("and 2 more notes")).toBeInTheDocument();
    expect(shareInspect).toHaveBeenLastCalledWith("/home/me/Biology.cerebra", "s3cret");

    const name = screen.getByLabelText("Collection name");
    expect(name).toHaveValue("Biology");
    expect(screen.getByText(/a number will be added/)).toBeInTheDocument();
    await user.clear(name);
    await user.type(name, "Bio from Sam");
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(shareImport).toHaveBeenCalledWith("/home/me/Biology.cerebra", { password: "s3cret", collection: "Bio from Sam" }));
    expect(await screen.findByText("Imported Bio from Sam")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Bio from Sam" })).toBeInTheDocument();
  });

  it("takes a typed path in the preview", async () => {
    const shareInspect = vi.fn(async () => ({ title: "Physics", counts: { notes: 1, files: 0, connections: 0, concepts: 0 }, notes: ["Force.md"], encrypted: false }));
    renderApp(<ImportDialog initialPath={null} onClose={() => {}} />, createFakeApi({ shareInspect }));
    const user = userEvent.setup();
    await user.type(await screen.findByPlaceholderText("/home/you/Downloads/Biology.cerebra"), "/tmp/Physics.cerebra");
    fireEvent.click(screen.getByRole("button", { name: "Look inside" }));
    await waitFor(() => expect(shareInspect).toHaveBeenCalledWith("/tmp/Physics.cerebra", undefined));
    expect(await screen.findByText("Force")).toBeInTheDocument();
  });
});
