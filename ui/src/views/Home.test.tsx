import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createFakeApi, emptyInfo } from "../test/fakeApi";
import { renderApp } from "../test/render";
import { Home } from "./Home";

describe("Home", () => {
  it("an empty library asks for the first material", async () => {
    renderApp(<Home />, createFakeApi({}, { info: emptyInfo, notes: [] }));
    expect(await screen.findByRole("heading", { name: "Add your first material" })).toBeInTheDocument();
    expect(screen.getByText("Drop files to start your library")).toBeInTheDocument();
    expect(screen.getByText("No collections yet")).toBeInTheDocument();
  });

  it("shows collection cards and quick actions", async () => {
    renderApp(<Home />, createFakeApi());
    expect(await screen.findByRole("link", { name: /Biology\s*3 notes/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^Physics\s*1 note(?!s)/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Upload/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /New note/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Connect a topic/ })).toBeEnabled();
  });
});
