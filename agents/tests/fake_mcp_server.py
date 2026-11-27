"""A tiny stand-in for `cerebra mcp --agent`, used to test MCPTools over real stdio."""

import json

from mcp.server.mcpserver import MCPServer

server = MCPServer("fake-cerebra")
NOTES = {"A.md": "Alpha text about membranes.", "B.md": "Beta text."}


@server.tool()
def read_note(note: str, heading: str | None = None, page: int | None = None) -> str:
    if note not in NOTES:
        raise ValueError(f"unknown note {note}")
    return NOTES[note]


@server.tool()
def candidates_for(note: str, idea: str, limit: int = 6) -> str:
    out = [{"note_id": p, "path": p, "title": p, "heading_path": "", "text": t} for p, t in NOTES.items() if p != note]
    return json.dumps(out[:limit])


@server.tool()
def save_connections(connections: list[dict], made_by: dict, status: str | None = None) -> str:
    return json.dumps({"saved": [f"c_{i}" for i in range(len(connections))], "rejected": [], "echo": made_by})


if __name__ == "__main__":
    server.run()
