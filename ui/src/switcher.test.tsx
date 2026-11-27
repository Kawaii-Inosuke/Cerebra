import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LibraryPicker, SwitcherProvider } from "./switcher";
import { createFakeApi } from "./test/fakeApi";
import { renderApp } from "./test/render";

const state = { library: "/home/me/Notes/Semester 3", recent: ["/home/me/Notes/Semester 3", "/home/me/Vaults/Work", "/media/usb/Old vault"] };

function setup(over = {}) {
  const api = createFakeApi(over);
  (api as { desktop: boolean }).desktop = true;
  const onChanged = vi.fn(async () => {});
  renderApp(
    <SwitcherProvider state={state} onChanged={onChanged}>
      <LibraryPicker />
    </SwitcherProvider>,
    api,
  );
  return { api, onChanged, user: userEvent.setup() };
}

describe("library picker", () => {
  it("lists recent libraries with paths and marks the current one", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: /Library: Semester 3/ }));
    const menu = await screen.findByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining("Semester 3"),
      expect.stringContaining("Work"),
      expect.stringContaining("Old vault"),
      expect.stringContaining("Open another folder…"),
      expect.stringContaining("Create a new library…"),
    ]);
    expect(within(items[0]!).getByLabelText("Open now")).toBeInTheDocument();
    expect(within(items[1]!).queryByLabelText("Open now")).not.toBeInTheDocument();
    expect(within(items[1]!).getByText("/home/me/Vaults/Work")).toBeInTheDocument();
  });

  it("switches with open_library and refreshes", async () => {
    const { api, onChanged, user } = setup();
    await user.click(screen.getByRole("button", { name: /Library: Semester 3/ }));
    await user.click(await screen.findByRole("menuitem", { name: /Work/ }));
    await waitFor(() => expect(api.openLibrary).toHaveBeenCalledWith("/home/me/Vaults/Work"));
    expect(onChanged).toHaveBeenCalled();
  });

  it("explains a missing library and drops it from the list", async () => {
    const openLibrary = vi.fn(async () => Promise.reject(new Error("/media/usb/Old vault isn't a folder")));
    const { onChanged, user } = setup({ openLibrary });
    await user.click(screen.getByRole("button", { name: /Library: Semester 3/ }));
    await user.click(await screen.findByRole("menuitem", { name: /Old vault/ }));
    expect(await screen.findByText("Couldn't open Old vault")).toBeInTheDocument();
    expect(screen.getByText("/media/usb/Old vault isn't a folder")).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /Library: Semester 3/ }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByText("Old vault")).not.toBeInTheDocument();
  });

  it("opens another folder through the dialog", async () => {
    const pickFolder = vi.fn(async () => "/home/me/New");
    const { api, user } = setup({ pickFolder });
    await user.click(screen.getByRole("button", { name: /Library: Semester 3/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Open another folder…" }));
    await waitFor(() => expect(api.openLibrary).toHaveBeenCalledWith("/home/me/New"));
  });
});
