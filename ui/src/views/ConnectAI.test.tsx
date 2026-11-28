import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createFakeApi } from "../test/fakeApi";
import { renderApp } from "../test/render";
import { ConnectAI } from "./ConnectAI";

describe("Connect your AI", () => {
  it("shows each app's status and config path, and connects / removes", async () => {
    const connectorConnect = vi.fn(async () => null);
    const connectorDisconnect = vi.fn(async () => null);
    const api = createFakeApi({ connectorConnect, connectorDisconnect });
    renderApp(<ConnectAI />, api);

    const desktop = await screen.findByTestId("app-claude_desktop");
    expect(within(desktop).getByText("/home/me/.config/Claude/claude_desktop_config.json")).toBeInTheDocument();
    const code = screen.getByTestId("app-claude_code");
    expect(within(code).getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText(/backs up each app's config file/)).toBeInTheDocument();

    fireEvent.click(within(desktop).getByRole("button", { name: /Connect/ }));
    await waitFor(() => expect(connectorConnect).toHaveBeenCalledWith("claude_desktop"));
    expect(await within(desktop).findByText(/Restart Claude Desktop/)).toBeInTheDocument();

    fireEvent.click(within(code).getByRole("button", { name: "Remove" }));
    expect(connectorDisconnect).not.toHaveBeenCalled();
    fireEvent.click(within(code).getByRole("button", { name: "Remove from Claude Code?" }));
    await waitFor(() => expect(connectorDisconnect).toHaveBeenCalledWith("claude_code"));
  });

  it("Store version: sets up Claude Desktop by hand with a copyable snippet", async () => {
    const connectorConnect = vi.fn(async () => null);
    const exe = "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\cerebra.exe";
    const api = createFakeApi({
      connectorConnect,
      connectorStatus: vi.fn(async () => ({
        claude_desktop: { connected: false, config: "C:\\Users\\me\\AppData\\Roaming\\Claude\\claude_desktop_config.json", command: exe, manual: true },
        claude_code: { connected: false, config: "C:\\Users\\me\\.claude.json", command: exe, manual: false },
        codex: { connected: false, config: "C:\\Users\\me\\.codex\\config.toml", command: exe, manual: false },
        cursor: { connected: false, config: "C:\\Users\\me\\.cursor\\mcp.json", command: exe, manual: false },
      })),
    });
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    renderApp(<ConnectAI />, api);

    const desktop = await screen.findByTestId("app-claude_desktop");
    expect(within(desktop).queryByRole("button", { name: /^Connect$/ })).not.toBeInTheDocument();
    await user.click(within(desktop).getByRole("button", { name: /Set up/ }));
    expect(within(desktop).getByText(/Settings/)).toBeInTheDocument();
    expect(within(desktop).getByText(/Edit Config/)).toBeInTheDocument();
    await user.click(within(desktop).getByRole("button", { name: /Copy setup/ }));
    const copied = JSON.parse(writeText.mock.calls[0]![0]);
    expect(copied).toEqual({ mcpServers: { cerebra: { command: exe, args: ["mcp"] } } });
    expect(connectorConnect).not.toHaveBeenCalled();
    // The other apps still connect in one click.
    expect(within(screen.getByTestId("app-codex")).getByRole("button", { name: /Connect/ })).toBeInTheDocument();
  });

  it("copies a context pack for a question", async () => {
    const contextPack = vi.fn(async () => ({ text: "## Osmosis\nWater moves…", tokens: 120, sources: [] }));
    const user = userEvent.setup();
    const writeText = vi.fn(async (_t: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderApp(<ConnectAI />, createFakeApi({ contextPack }));

    await user.type(await screen.findByRole("textbox", { name: "Question" }), "How do plants get water?");
    await user.selectOptions(screen.getByRole("combobox", { name: "Collection" }), "Biology");
    fireEvent.click(screen.getByRole("button", { name: /Copy context/ }));
    await waitFor(() => expect(contextPack).toHaveBeenCalledWith("How do plants get water?", "Biology"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("## Osmosis\nWater moves…"));
    expect(screen.getByText(/Using my Cerebra notes, explain osmosis/)).toBeInTheDocument();
    expect(screen.getByText(/"mcpServers"/)).toBeInTheDocument();
    expect(screen.getByText(/<path to the Cerebra app>/)).toBeInTheDocument();
  });

  it("puts the Cerebra program path in the MCP snippet when known", async () => {
    const connectorStatus = vi.fn(async () => ({
      claude_desktop: { connected: false, config: null, command: "/opt/Cerebra/cerebra" },
      claude_code: { connected: false, config: null, command: "/opt/Cerebra/cerebra" },
      codex: { connected: false, config: null },
      cursor: { connected: false, config: null },
    }));
    renderApp(<ConnectAI />, createFakeApi({ connectorStatus }));
    expect(await screen.findByText(/"command": "\/opt\/Cerebra\/cerebra"/)).toBeInTheDocument();
  });
});
