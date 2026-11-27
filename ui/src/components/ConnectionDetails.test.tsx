import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createFakeApi, mapConnection } from "../test/fakeApi";
import { renderApp } from "../test/render";
import { ConnectionDetails } from "./ConnectionDetails";

describe("connection details (clicked AI arrow)", () => {
  it("shows the relationship, the reason and a quote from each note", () => {
    renderApp(<ConnectionDetails c={mapConnection()} onClose={() => {}} />, createFakeApi());
    expect(screen.getByRole("button", { name: "Membrane" })).toBeInTheDocument();
    expect(screen.getByText("part of")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cell" })).toBeInTheDocument();
    expect(screen.getByText("The membrane is the cell's boundary.")).toBeInTheDocument();
    expect(screen.getByText("“The membrane surrounds the cell.”")).toBeInTheDocument();
    expect(screen.getByText("“A cell has a membrane.”")).toBeInTheDocument();
  });

  it("keeps a suggested connection", async () => {
    const api = createFakeApi();
    renderApp(<ConnectionDetails c={mapConnection({ status: "suggested" })} onClose={() => {}} />, api);
    await userEvent.click(screen.getByRole("button", { name: /Keep/ }));
    expect(api.aiSetStatus).toHaveBeenCalledWith(["c1"], "kept");
  });

  it("rejecting closes the panel", async () => {
    const api = createFakeApi();
    const onClose = vi.fn();
    renderApp(<ConnectionDetails c={mapConnection({ status: "suggested" })} onClose={onClose} />, api);
    await userEvent.click(screen.getByRole("button", { name: /Reject/ }));
    expect(api.aiSetStatus).toHaveBeenCalledWith(["c1"], "dismissed");
    expect(onClose).toHaveBeenCalled();
  });

  it("offers Remove (not Keep) for a connection already kept", () => {
    renderApp(<ConnectionDetails c={mapConnection()} onClose={() => {}} />, createFakeApi());
    expect(screen.queryByRole("button", { name: /Keep/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Remove/ })).toBeInTheDocument();
  });
});
