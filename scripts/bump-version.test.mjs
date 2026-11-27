// node --test scripts/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { changelogFor, FILES, readVersions, setVersion } from "./bump-version.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("every version in the repository agrees", () => {
  const versions = readVersions(root);
  assert.equal(new Set(Object.values(versions)).size, 1, JSON.stringify(versions, null, 2));
});

test("setting a version changes every place and nothing else", () => {
  const files = Object.fromEntries(FILES.map((f) => [f.path, readFileSync(join(root, f.path), "utf8")]));
  const bumped = Object.fromEntries(FILES.map((f) => [f.path, setVersion(files[f.path], f, "9.8.7")]));
  const versions = readVersions(root, (p) => bumped[p]);
  assert.deepEqual(new Set(Object.values(versions)), new Set(["9.8.7"]));
  for (const f of FILES) {
    const old = files[f.path].split("\n");
    const now = bumped[f.path].split("\n");
    assert.equal(now.length, old.length, f.path);
    const changed = now.filter((l, i) => l !== old[i]);
    assert.ok(changed.length >= 1 && changed.every((l) => l.includes("9.8.7")), `${f.path}: ${changed.join(" | ")}`);
  }
  // Dependencies that happen to share the version are left alone.
  assert.ok(!/name = "serde"\nversion = "9\.8\.7"/.test(bumped["Cargo.lock"]));
});

test("the CHANGELOG gets a section for the new version", () => {
  const base = "# Changelog\n\nIntro.\n\n## [0.1.0] - 2026-11-27\n\n- first\n";
  const out = changelogFor(base, "0.2.0", "2026-12-01");
  assert.match(out, /## \[0\.2\.0\] - 2026-12-01\n\n### Changed\n- \n\n## \[0\.1\.0\]/);
  assert.equal(changelogFor(out, "0.2.0"), out);
  assert.match(changelogFor("# C\n\n## [Unreleased]\n- x\n", "0.3.0", "2027-01-01"), /## \[0\.3\.0\] - 2027-01-01\n- x/);
});
