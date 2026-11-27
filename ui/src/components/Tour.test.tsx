import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { markTour, placeCard, TOUR_KEY, TOUR_STEPS, tourSeen } from "../lib/tour";
import { createFakeApi } from "../test/fakeApi";
import { renderApp } from "../test/render";
import { TourProvider, useTour } from "./Tour";

function StartButton() {
  const tour = useTour();
  return (
    <button type="button" onClick={() => tour?.start()}>
      start
    </button>
  );
}

const offer = () => screen.findByRole("dialog", { name: "Want a quick tour?" }, { timeout: 2000 });

describe("tour placement", () => {
  const vp = { width: 1200, height: 800 };
  const card = { width: 340, height: 200 };

  it("puts the card right of sidebar items", () => {
    const p = placeCard({ top: 100, left: 8, width: 200, height: 32 }, card, vp);
    expect(p.side).toBe("right");
    expect(p.left).toBe(8 + 200 + 14);
  });

  it("puts the card below things in the main area and keeps it in the window", () => {
    const p = placeCard({ top: 10, left: 1000, width: 190, height: 32 }, card, vp);
    expect(p.side).toBe("bottom");
    expect(p.left + card.width).toBeLessThanOrEqual(vp.width - 12);
  });

  it("goes above when there's no room below", () => {
    expect(placeCard({ top: 700, left: 600, width: 100, height: 40 }, card, vp).side).toBe("top");
  });

  it("centres the card when there's nothing to point at", () => {
    expect(placeCard(null, card, vp)).toEqual({ top: 300, left: 430, side: "center" });
  });
});

describe("tour memory", () => {
  it("remembers that the tour was finished or skipped", () => {
    expect(tourSeen()).toBe(false);
    markTour("skipped");
    expect(tourSeen()).toBe(true);
    localStorage.setItem(TOUR_KEY, "done");
    expect(tourSeen()).toBe(true);
  });
});

describe("guided tour", () => {
  it("is offered the first time, and Skip closes it for good", async () => {
    renderApp(<TourProvider />, createFakeApi());
    await userEvent.click(await within(await offer()).findByRole("button", { name: "Skip for now" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(localStorage.getItem(TOUR_KEY)).toBe("skipped");
  });

  it("is not offered again once seen", async () => {
    markTour("done");
    renderApp(<TourProvider />, createFakeApi());
    await act(() => new Promise((r) => setTimeout(r, 700)));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("walks through every step with Next and Back, then finishes", async () => {
    const user = userEvent.setup();
    renderApp(<TourProvider />, createFakeApi());
    await user.click(await within(await offer()).findByRole("button", { name: /Show me around/ }));
    expect(screen.getByRole("dialog", { name: TOUR_STEPS[0]!.title })).toBeInTheDocument();
    expect(screen.getByText(`Step 1 of ${TOUR_STEPS.length}`)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("dialog", { name: TOUR_STEPS[1]!.title })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Previous step" }));
    expect(screen.getByRole("dialog", { name: TOUR_STEPS[0]!.title })).toBeInTheDocument();
    for (let i = 1; i < TOUR_STEPS.length; i++) await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("dialog", { name: TOUR_STEPS.at(-1)!.title })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Finish" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(localStorage.getItem(TOUR_KEY)).toBe("done");
    expect(location.hash).toBe("#/");
  });

  it("can be skipped at any step with the button or Escape", async () => {
    const user = userEvent.setup();
    markTour("done");
    renderApp(
      <TourProvider>
        <StartButton />
      </TourProvider>,
      createFakeApi(),
    );
    await user.click(screen.getByRole("button", { name: "start" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Skip tour" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(localStorage.getItem(TOUR_KEY)).toBe("skipped");

    await user.click(screen.getByRole("button", { name: "start" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("moves to the screen each step is about", async () => {
    const user = userEvent.setup();
    markTour("done");
    renderApp(
      <TourProvider>
        <StartButton />
      </TourProvider>,
      createFakeApi(),
    );
    await user.click(screen.getByRole("button", { name: "start" }));
    const graph = TOUR_STEPS.findIndex((s) => s.id === "graph");
    for (let i = 0; i < graph; i++) await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("dialog", { name: TOUR_STEPS[graph]!.title })).toBeInTheDocument();
    expect(location.hash).toBe("#/graph");
  });
});
