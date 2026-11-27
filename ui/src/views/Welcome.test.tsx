import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Welcome } from "./FirstRun";

describe("welcome screen", () => {
  it("offers three plain choices and nothing else", () => {
    const onCreate = vi.fn();
    const onOpen = vi.fn();
    const onOpenFile = vi.fn();
    render(<Welcome busy={false} error={null} onCreate={onCreate} onOpen={onOpen} onOpenFile={onOpenFile} />);
    expect(screen.queryByText(/A library is just a folder on your computer/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Start a new library/ }));
    fireEvent.click(screen.getByRole("button", { name: /Use a folder I already have/ }));
    fireEvent.click(screen.getByRole("button", { name: /Open notes someone shared/ }));
    expect([onCreate, onOpen, onOpenFile].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
    expect(screen.queryByText(/Add an AI/)).not.toBeInTheDocument();
  });
});
