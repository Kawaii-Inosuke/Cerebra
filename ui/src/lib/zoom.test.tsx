import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createFakeApi } from "../test/fakeApi";
import { renderApp } from "../test/render";
import { Settings } from "../views/Settings";
import { nearestStep, stepZoom, zoomKey } from "./zoom";

describe("text size", () => {
  it("steps between 90% and 145%", () => {
    expect(stepZoom(1.15, 1)).toBe(1.3);
    expect(stepZoom(1.15, -1)).toBe(1.0);
    expect(stepZoom(1.45, 1)).toBe(1.45);
    expect(stepZoom(0.9, -1)).toBe(0.9);
    expect(nearestStep(1.2)).toBe(2);
    expect(zoomKey({ key: "=", ctrlKey: true, metaKey: false, altKey: false })).toBe("in");
    expect(zoomKey({ key: "+", ctrlKey: false, metaKey: true, altKey: false })).toBe("in");
    expect(zoomKey({ key: "-", ctrlKey: true, metaKey: false, altKey: false })).toBe("out");
    expect(zoomKey({ key: "0", ctrlKey: true, metaKey: false, altKey: false })).toBe("reset");
    expect(zoomKey({ key: "=", ctrlKey: false, metaKey: false, altKey: false })).toBeNull();
  });

  it("Settings shows the current size and calls set_zoom with the step's value", async () => {
    const api = createFakeApi();
    renderApp(<Settings />, api);
    const group = await screen.findByRole("radiogroup", { name: "Text size" });
    await waitFor(() => expect(screen.getByRole("radio", { name: "115%" })).toHaveAttribute("aria-checked", "true"));
    expect(group).toHaveTextContent("90%100%115%130%145%");
    fireEvent.click(screen.getByRole("radio", { name: "130%" }));
    await waitFor(() => expect(api.setZoom).toHaveBeenLastCalledWith(1.3));
    expect(screen.getByRole("radio", { name: "130%" })).toHaveAttribute("aria-checked", "true");
  });

  it("keyboard shortcuts zoom in, out and reset", async () => {
    const api = createFakeApi();
    renderApp(<Settings />, api);
    await screen.findByRole("radiogroup", { name: "Text size" });
    await waitFor(() => expect(api.getZoom).toHaveBeenCalled());
    fireEvent.keyDown(window, { key: "=", ctrlKey: true });
    await waitFor(() => expect(api.setZoom).toHaveBeenLastCalledWith(1.3));
    fireEvent.keyDown(window, { key: "=", ctrlKey: true });
    await waitFor(() => expect(api.setZoom).toHaveBeenLastCalledWith(1.45));
    fireEvent.keyDown(window, { key: "-", metaKey: true });
    await waitFor(() => expect(api.setZoom).toHaveBeenLastCalledWith(1.3));
    fireEvent.keyDown(window, { key: "0", ctrlKey: true });
    await waitFor(() => expect(api.setZoom).toHaveBeenLastCalledWith(1.15));
  });
});
