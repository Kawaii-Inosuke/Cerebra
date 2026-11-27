import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BUILD_VERSION, bugReportText, LINKS, newIssueUrl, osName } from "../lib/appInfo";
import { createFakeApi } from "../test/fakeApi";
import { renderApp } from "../test/render";
import { AboutDialog, reflow } from "./About";
import pkg from "../../../package.json";

describe("app info", () => {
  it("takes the version from package.json, never a hand-typed number", () => {
    expect(BUILD_VERSION).toBe(pkg.version);
  });

  it("names the operating system", () => {
    expect(osName("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("Windows");
    expect(osName("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)")).toBe("macOS");
    expect(osName("Mozilla/5.0 (X11; Linux x86_64)")).toBe("Linux");
  });

  it("puts only the given facts in a bug report", () => {
    const text = bugReportText({ version: "1.2.3", os: "Linux", desktop: true, models: "ready", agents: "2 AI sources" });
    expect(text).toBe("Cerebra 1.2.3\nSystem: Linux\nBuild: desktop app\nSearch and OCR models: ready\nAgents: 2 AI sources");
  });

  it("opens new issues on the project's GitHub with the details filled in", () => {
    const url = new URL(newIssueUrl("Cerebra 1.2.3"));
    expect(`${url.origin}${url.pathname}`).toBe(`${LINKS.issues}/new`);
    expect(url.searchParams.get("body")).toContain("Cerebra 1.2.3");
  });
});

describe("About window", () => {
  it("reflows hard-wrapped licence text into paragraphs", () => {
    expect(reflow("one\ntwo\n\nthree\nfour\n")).toBe("one two\n\nthree four\n");
  });

  it("has no source-code or docs link, and no credits section", async () => {
    renderApp(<AboutDialog open onOpenChange={() => {}} />, createFakeApi());
    await screen.findByTestId("about-version");
    expect(screen.queryByRole("button", { name: /Source code/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Documentation/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Credits/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Obsidian/)).not.toBeInTheDocument();
  });

  it("explains what the app does", async () => {
    renderApp(<AboutDialog open onOpenChange={() => {}} />, createFakeApi());
    expect(await screen.findByRole("heading", { name: "What Cerebra does" })).toBeInTheDocument();
    expect(screen.getByText("Finds the connections that matter")).toBeInTheDocument();
    expect(screen.getByText("Stays private")).toBeInTheDocument();
  });

  it("shows the app's real version", async () => {
    renderApp(<AboutDialog open onOpenChange={() => {}} />, createFakeApi());
    expect(await screen.findByTestId("about-version")).toHaveTextContent(`Version ${pkg.version}`);
  });

  it("opens links in the system browser", async () => {
    const api = createFakeApi();
    renderApp(<AboutDialog open onOpenChange={() => {}} />, api);
    await userEvent.click(await screen.findByRole("button", { name: /Check for updates/ }));
    expect(api.openExternal).toHaveBeenCalledWith(LINKS.latest);
    await userEvent.click(screen.getByRole("button", { name: /Report a problem/ }));
    expect(vi.mocked(api.openExternal).mock.calls.at(-1)?.[0]).toMatch(/\/issues\/new\?body=/);
  });

  it("shows the licence and the third-party notices inside the app", async () => {
    renderApp(<AboutDialog open onOpenChange={() => {}} />, createFakeApi());
    await userEvent.click(await screen.findByRole("button", { name: /Read the licence/ }));
    expect(screen.getByText(/Permission is hereby granted, free of charge/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Back to About" }));
    await userEvent.click(screen.getByRole("button", { name: /Third-party notices/ }));
    expect(screen.getByRole("heading", { name: "Third-party notices" })).toBeInTheDocument();
  });

  it("copies bug-report details without keys or note content", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    renderApp(<AboutDialog open onOpenChange={() => {}} />, createFakeApi());
    await screen.findByText(`Version ${pkg.version}`);
    await user.click(screen.getByRole("button", { name: /Copy details for a bug report/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const copied = writeText.mock.calls[0]![0];
    expect(copied).toContain(`Cerebra ${pkg.version}`);
    expect(copied).not.toMatch(/key|sk-|AIza|gsk_/i);
    expect(copied).not.toMatch(/Cell|Membrane|Biology/);
    expect(await screen.findByRole("button", { name: /Copied/ })).toBeInTheDocument();
  });
});
