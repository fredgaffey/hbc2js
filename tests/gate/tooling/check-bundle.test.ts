import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { repoRoot } from "../../support/paths.ts";
import { checkBundle } from "../../../src/tooling/check-bundle.ts";

const GOOD_DIR = join(repoRoot(), "tests", "fixtures", "tooling", "good");
const BAD_DIR = join(repoRoot(), "tests", "fixtures", "tooling", "bad");
const CLI = join(repoRoot(), "src", "cli.ts");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

test("check-bundle: clean 6-module fixture reports ok:true, no defects", async () => {
  const text = read(join(GOOD_DIR, "combined.js"));
  const result = await checkBundle(text, { root: GOOD_DIR, fileExists: existsSync });
  assert.equal(result.modules, 6);
  assert.deepEqual(result.missingRequires, []);
  assert.deepEqual(result.duplicateIds, []);
  assert.deepEqual(result.freeGlobals, []);
  assert.deepEqual(result.missingAssets, []);
  assert.equal(result.ok, true);
});

test("check-bundle: bad fixture finds all four defect classes and only those", async () => {
  const text = read(join(BAD_DIR, "combined.js"));
  const result = await checkBundle(text, { root: BAD_DIR, fileExists: existsSync });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingRequires, [{ from: 1, to: 9 }]);
  assert.deepEqual(result.duplicateIds, [2]);
  assert.deepEqual(result.freeGlobals, [{ name: "someHostGlobal", modules: [3] }]);
  assert.equal(result.missingAssets.length, 1);
  assert.equal(result.missingAssets[0]?.module, 4);
  assert.equal(result.missingAssets[0]?.name, "missing-icon");
});

test("check-bundle CLI: --json on the clean fixture prints one ok:true object, exits 0", () => {
  const r = spawnSync(process.execPath, [CLI, "check-bundle", join(GOOD_DIR, "combined.js"), "--root", GOOD_DIR, "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.modules, 6);
});

test("check-bundle CLI: --json on the bad fixture still exits 0 (measured successfully) but reports ok:false", () => {
  const r = spawnSync(process.execPath, [CLI, "check-bundle", join(BAD_DIR, "combined.js"), "--root", BAD_DIR, "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.duplicateIds.length, 1);
  assert.equal(parsed.missingRequires.length, 1);
  assert.equal(parsed.freeGlobals.length, 1);
  assert.equal(parsed.missingAssets.length, 1);
});

test("check-bundle CLI: defaults --root to the bundle's own directory", () => {
  const r = spawnSync(process.execPath, [CLI, "check-bundle", join(GOOD_DIR, "combined.js"), "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
});

test("check-bundle CLI: --help prints usage and exits 0", () => {
  const r = spawnSync(process.execPath, [CLI, "check-bundle", "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
});

test("check-bundle CLI: no input exits 2", () => {
  const r = spawnSync(process.execPath, [CLI, "check-bundle"], { encoding: "utf8" });
  assert.equal(r.status, 2);
});

test("check-bundle CLI: unreadable file exits non-zero, human text mode", () => {
  const r = spawnSync(process.execPath, [CLI, "check-bundle", join(BAD_DIR, "does-not-exist.js")], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
});
