import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LINKS } from "../lib/appInfo";
import { AUTO_KEY, autoCheck, LATER_MS, plainNotes, remindLater, setAutoCheck, snoozed, SNOOZE_KEY, type UpdateInfo } from "../lib/updates";
import { createFakeApi } from "../test/fakeApi";
import { renderApp } from "../test/render";
import { UpdateProvider } from "./UpdatePrompt";

const github: UpdateInfo = { version: "0.1.2", current: "0.1.1", notes: "### Fixed\n- **Faster** search", mode: "in_place" };

function desktopApi(info: UpdateInfo | null, extra = {}) {
  const api = createFakeApi({ updateCheck: vi.fn(async () => info), ...extra });
  (api as { desktop: boolean }).desktop = true;
  return api;
}

const prompt = () => screen.findByRole("dialog", { name: /Cerebra 0\.1\.2 is available/ });

describe("update rules", () => {
  it("checks automatically unless turned off", () => {
    expect(autoCheck()).toBe(true);
    setAutoCheck(false);
    expect(localStorage.getItem(AUTO_KEY)).toBe("off");
    expect(autoCheck()).toBe(false);
  });

  it("“Later” waits a day for that version only", () => {
    remindLater("0.1.2", 1000);
    expect(snoozed("0.1.2", 1000 + LATER_MS - 1)).toBe(true);
    expect(snoozed("0.1.2", 1000 + LATER_MS)).toBe(false);
    expect(snoozed("0.1.3", 1001)).toBe(false);
    localStorage.setItem(SNOOZE_KEY, "not json");
    expect(snoozed("0.1.2")).toBe(false);
  });

  it("turns release notes into short plain text", () => {
    expect(plainNotes("### Fixed\n- **Faster** [search](https://x)\n\n\n\nmore")).toBe("Fixed\n- Faster search\n\nmore");
    expect(plainNotes("x".repeat(50), 10)).toBe(`${"x".repeat(9)}…`);
    expect(plainNotes(null)).toBe("");
  });
});

describe("new version window", () => {
  it("appears after start with the version and what's new", async () => {
    renderApp(<UpdateProvider delay={0} />, desktopApi(github));
    const d = await prompt();
    expect(d).toHaveTextContent("You have 0.1.1.");
    expect(d).toHaveTextContent("Faster search");
    expect(screen.getByRole("button", { name: /Update now/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Later" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next time I open Cerebra" })).toBeInTheDocument();
  });

  it("Update now installs it", async () => {
    const api = desktopApi(github);
    renderApp(<UpdateProvider delay={0} />, api);
    await userEvent.click(await screen.findByRole("button", { name: /Update now/ }));
    expect(api.updateInstall).toHaveBeenCalled();
  });

  it("Later closes it and remembers for a day", async () => {
    renderApp(<UpdateProvider delay={0} />, desktopApi(github));
    await userEvent.click(await screen.findByRole("button", { name: "Later" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(snoozed("0.1.2")).toBe(true);
  });

  it("Next time closes it without remembering anything", async () => {
    renderApp(<UpdateProvider delay={0} />, desktopApi(github));
    await userEvent.click(await screen.findByRole("button", { name: "Next time I open Cerebra" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(snoozed("0.1.2")).toBe(false);
  });

  it("stays quiet when snoozed, turned off, up to date, or in the browser", async () => {
    remindLater("0.1.2");
    const a = desktopApi(github);
    renderApp(<UpdateProvider delay={0} />, a);
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    localStorage.clear();
    setAutoCheck(false);
    const b = desktopApi(github);
    renderApp(<UpdateProvider delay={0} />, b);
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(b.updateCheck).not.toHaveBeenCalled();

    const c = createFakeApi({ updateCheck: vi.fn(async () => github) }); // browser preview
    renderApp(<UpdateProvider delay={0} />, c);
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(c.updateCheck).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Store version: the Store installs it", async () => {
    const api = desktopApi({ version: "0.1.2", current: "0.1.1", notes: null, mode: "store" });
    renderApp(<UpdateProvider delay={0} />, api);
    expect(await prompt()).toHaveTextContent("The Microsoft Store will download and install it.");
    await userEvent.click(screen.getByRole("button", { name: /Update now/ }));
    await waitFor(() => expect(api.updateInstall).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it(".deb / .rpm installs: Update now opens the download page", async () => {
    const api = desktopApi({ ...github, mode: "download_page" });
    renderApp(<UpdateProvider delay={0} />, api);
    await userEvent.click(await screen.findByRole("button", { name: /Update now/ }));
    expect(api.openExternal).toHaveBeenCalledWith(LINKS.latest);
    expect(api.updateInstall).not.toHaveBeenCalled();
  });
});
