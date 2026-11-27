// Builds the Python agents sidecar (agents/) into one binary with PyInstaller and puts it where Tauri's
// `externalBin` expects it: src-tauri/binaries/cerebra-agents-<rust host triple>[.exe].
//
//   node scripts/build-sidecar.mjs
//
// Needs `uv` (https://docs.astral.sh/uv/) and `rustc` on PATH. Builds for the machine it runs on;
// PyInstaller cannot cross-compile, so CI runs this once per OS.

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const agents = join(root, "agents");
const isWindows = process.platform === "win32";
const exe = isWindows ? ".exe" : "";

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  return execFileSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });
}

function hostTriple() {
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const line = out.split(/\r?\n/).find((l) => l.startsWith("host:"));
  if (!line) throw new Error("could not read the host triple from `rustc -vV`");
  return line.slice("host:".length).trim();
}

const triple = hostTriple();

run("uv", ["sync", "--directory", agents, "--frozen"]);
run("uv", [
  "run",
  "--directory",
  agents,
  "pyinstaller",
  "--noconfirm",
  "--clean",
  "--log-level",
  "WARN",
  "--distpath",
  join(agents, "dist"),
  "--workpath",
  join(agents, "build"),
  join(agents, "cerebra-agents.spec"),
]);

const built = join(agents, "dist", `cerebra-agents${exe}`);
if (!existsSync(built)) throw new Error(`PyInstaller did not produce ${built}`);

const outDir = join(root, "src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });
const target = join(outDir, `cerebra-agents-${triple}${exe}`);
copyFileSync(built, target);
if (!isWindows) chmodSync(target, 0o755);

const mb = (statSync(target).size / 1024 / 1024).toFixed(1);
console.log(`sidecar ready: ${target} (${mb} MB)`);
