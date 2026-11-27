import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createFakeApi, emptyInfo } from "../test/fakeApi";
import { renderApp } from "../test/render";
import { Sidebar } from "./Sidebar";

describe("Sidebar", () => {
  it("lists collections with their note counts", async () => {
    renderApp(<Sidebar route={{ name: "home" }} />, createFakeApi());
    const list = await screen.findByRole("list", { name: "Collections" });
    const bio = await within(list).findByTestId("collection-Biology");
    expect(bio).toHaveTextContent("Biology");
    expect(bio).toHaveTextContent("3");
    expect(within(list).getByTestId("collection-Physics")).toHaveTextContent("1");
    expect(screen.getByRole("link", { name: /Home/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: /Review/ })).toHaveAttribute("href", "#/review");
  });

  it("shows a friendly empty state without collections", async () => {
    renderApp(<Sidebar route={{ name: "home" }} />, createFakeApi({}, { info: emptyInfo, notes: [] }));
    expect(await screen.findByText(/No collections yet/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "New collection" }).length).toBeGreaterThan(0);
  });
});
