#!/usr/bin/env node
// Sets Cerebra's version everywhere it is written down, in one go.
//
//   node scripts/bump-version.mjs 0.2.0     change every file to 0.2.0 and start a CHANGELOG section
//   node scripts/bump-version.mjs --check   fail if the files disagree (CI runs this)
//   node scripts/bump-version.mjs --check v0.2.0   …and also fail unless they all say 0.2.0 (release CI)
//
// Plain Node, no dependencies.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Each place the version lives: how to read it and how to rewrite it. */
export const FILES = [
  { path: "package.json", re: /^(\s*"version":\s*")([^"]+)(")/m },
  { path: "package-lock.json", re: /^(\{\s*"name":\s*"cerebra",\s*"version":\s*")([^"]+)(")/, also: /("packages":\s*\{\s*"":\s*\{\s*"name":\s*"cerebra",\s*"version":\s*")([^"]+)(")/ },
  { path: "Cargo.toml", re: /(\[workspace\.package\][^[]*?\nversion\s*=\s*")([^"]+)(")/ },
  { path: "Cargo.lock", re: /(name = "cerebra-core"\nversion = ")([^"]+)(")/, also: [/(name = "cerebra-cli"\nversion = ")([^"]+)(")/, /(name = "cerebra-app"\nversion = ")([^"]+)(")/] },
  { path: "src-tauri/tauri.conf.json", re: /^(\s*"version":\s*")([^"]+)(")/m },
  { path: "agents/pyproject.toml", re: /(\[project\][^[]*?\nversion\s*=\s*")([^"]+)(")/ },
  { path: "agents/uv.lock", re: /(name = "cerebra-agents"\nversion = ")([^"]+)(")/ },
  { path: "agents/cerebra_agents/__init__.py", re: /^(__version__\s*=\s*")([^"]+)(")/m },
];

const allPatterns = (f) => [f.re, ...(f.also ? [].concat(f.also) : [])];

/** `{ path: version }` for every place; throws if a pattern no longer matches its file. */
export function readVersions(root, read = (p) => readFileSync(join(root, p), "utf8")) {
  const out = {};
  for (const f of FILES) {
    const text = read(f.path);
    allPatterns(f).forEach((re, i) => {
      const m = text.match(re);
      if (!m) throw new Error(`Couldn't find the version in ${f.path} (pattern ${i + 1}). Update scripts/bump-version.mjs.`);
      out[i ? `${f.path}#${i}` : f.path] = m[2];
    });
  }
  return out;
}

export function setVersion(text, f, version) {
  let t = text;
  for (const re of allPatterns(f)) t = t.replace(re, (_, a, _old, c) => `${a}${version}${c}`);
  return t;
}

/** Renames "## [Unreleased]" (or adds a heading) so the new version has a CHANGELOG section. */
export function changelogFor(text, version, today = new Date().toISOString().slice(0, 10)) {
  if (text.includes(`## [${version}]`)) return text;
  const heading = `## [${version}] - ${today}`;
  if (/^## \[Unreleased\]/im.test(text)) return text.replace(/^## \[Unreleased\].*$/im, heading);
  const first = text.search(/^## \[/m);
  if (first < 0) return `${text.trimEnd()}\n\n${heading}\n\n- \n`;
  return `${text.slice(0, first)}${heading}\n\n### Changed\n- \n\n${text.slice(first)}`;
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const args = process.argv.slice(2);
  if (args[0] === "--check") {
    const versions = readVersions(root);
    const distinct = [...new Set(Object.values(versions))];
    const want = args[1]?.replace(/^v/, "");
    if (distinct.length !== 1) {
      console.error("The version is not the same everywhere:");
      for (const [p, v] of Object.entries(versions)) console.error(`  ${v.padEnd(12)} ${p}`);
      console.error("Fix it with: node scripts/bump-version.mjs <x.y.z>");
      process.exit(1);
    }
    if (want && distinct[0] !== want) {
      console.error(`The tag says ${want} but the app says ${distinct[0]}. Run: node scripts/bump-version.mjs ${want}`);
      process.exit(1);
    }
    console.log(`Version ${distinct[0]} everywhere.`);
    return;
  }
  const version = args[0]?.replace(/^v/, "");
  if (!version || !SEMVER.test(version)) {
    console.error("Usage: node scripts/bump-version.mjs <x.y.z>   or   --check [vX.Y.Z]");
    process.exit(2);
  }
  for (const f of FILES) {
    const p = join(root, f.path);
    const before = readFileSync(p, "utf8");
    const after = setVersion(before, f, version);
    if (after !== before) writeFileSync(p, after);
  }
  const cl = join(root, "CHANGELOG.md");
  writeFileSync(cl, changelogFor(readFileSync(cl, "utf8"), version));
  readVersions(root); // throws if anything was missed
  console.log(`Version set to ${version}. Next: fill in CHANGELOG.md, commit, then: git tag v${version} && git push --tags`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
