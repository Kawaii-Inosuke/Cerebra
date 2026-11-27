from __future__ import annotations

import sys
from pathlib import Path

import pytest

from cerebra_agents.tools import MCPTools, ToolError

SERVER = Path(__file__).with_name("fake_mcp_server.py")


async def test_mcp_tools_over_stdio():
    async with MCPTools(sys.executable, [str(SERVER)]) as tools:
        assert await tools.read_note("A.md") == "Alpha text about membranes."
        cands = await tools.candidates_for("A.md", "membranes")
        assert [c["path"] for c in cands] == ["B.md"]
        report = await tools.save_connections(
            {"connections": [{"from": "A.md", "to": "B.md"}], "made_by": {"kind": "agent"}, "status": "suggested"}
        )
        assert report["saved"] == ["c_0"] and report["echo"] == {"kind": "agent"}
        with pytest.raises(ToolError):
            await tools.read_note("missing.md")
