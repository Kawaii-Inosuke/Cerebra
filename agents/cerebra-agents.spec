# PyInstaller spec for the Cerebra agents sidecar (one-file binary).
# Build with:  uv run --directory agents pyinstaller --noconfirm --clean cerebra-agents.spec
# (or `node scripts/build-sidecar.mjs` from the repo root, which also copies it into src-tauri/binaries).
from PyInstaller.utils.hooks import collect_data_files, collect_submodules, copy_metadata

hiddenimports = []
hiddenimports += collect_submodules("cerebra_agents")
hiddenimports += collect_submodules("strands.models")
hiddenimports += collect_submodules("strands.multiagent", filter=lambda name: ".a2a" not in name)
hiddenimports += collect_submodules("strands.tools")
hiddenimports += collect_submodules("mcp.client")
hiddenimports += [
    # Provider SDKs are imported lazily by Strands.
    "google.genai",
    "openai",
    "anthropic",
    "ollama",
    "mistralai",
    # OpenTelemetry picks its context implementation through entry points.
    "opentelemetry.context.contextvars_context",
]

datas = []
datas += collect_data_files("cerebra_agents", includes=["prompts/*.md"])
datas += collect_data_files("strands")
for dist in ("strands-agents", "opentelemetry-api", "opentelemetry-sdk", "mcp", "openai", "anthropic",
             "google-genai", "ollama", "mistralai", "pydantic"):
    try:
        datas += copy_metadata(dist)
    except Exception:
        pass

a = Analysis(
    ["cerebra_agents/__main__.py"],
    pathex=["."],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "pytest", "IPython", "matplotlib", "numpy.tests"],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="cerebra-agents",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
