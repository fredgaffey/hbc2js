// Fixtures: two committed construct fixtures
// (tests/fixtures/constructs/101-irreducible-loop-window,
// tests/fixtures/constructs/22-nested-closures-counters, each compiled by
// tests/fixtures/build.sh -> v99.hbc). `rebuilt.hbc` is generated fresh in
// this test by decompiling that v99.hbc with hbc2js's own decompiler and
// recompiling the result with hermesc v99 (tests/support/hermesc.ts, same
// pattern as tests/gate/harness/roundtrip.test.ts) -- never a hand-written
// stand-in, since the whole point of `sizeDiff` is to measure what a real
// decompile+recompile round trip does to size and shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { repoRoot } from "../../support/paths.ts";
import { findHermesc, runHermesc } from "../../support/hermesc.ts";
import { requireOracles } from "../../support/tiers.ts";
import { decompile } from "../../../src/decompile.ts";
import { sizeDiff } from "../../../src/tooling/sizediff.ts";

const CLI = join(repoRoot(), "src", "cli.ts");
const CONSTRUCTS = join(repoRoot(), "tests", "fixtures", "constructs");

/** Decompiles `<name>/v99.hbc` and recompiles the result with hermesc v99,
 *  returning both hbc byte buffers. `null` (with the caller skipping) when
 *  hermesc v99 isn't available locally and oracles aren't required. */
function buildPair(name: string): { readonly original: Uint8Array; readonly rebuilt: Uint8Array } | null {
  const hermesc = findHermesc(99);
  if (hermesc === null) return null;
  const original = new Uint8Array(readFileSync(join(CONSTRUCTS, name, "v99.hbc")));
  const code = decompile(original).code;
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-sizediff-test-"));
  try {
    writeFileSync(join(dir, "input.js"), code);
    const out = join(dir, "out.hbc");
    const r = runHermesc(hermesc, ["-emit-binary", `-out=${out}`, "input.js"], dir);
    assert.equal(r.status, 0, `hermesc failed on ${name}: ${r.stderr}`);
    const rebuilt = new Uint8Array(readFileSync(out));
    return { original, rebuilt };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function skipOrPair(t: import("node:test").TestContext, name: string): { readonly original: Uint8Array; readonly rebuilt: Uint8Array } | null {
  const pair = buildPair(name);
  if (pair === null) {
    const msg = "hermesc v99 not found (run tools/get-hermesc.sh 99)";
    if (requireOracles()) throw new Error(msg);
    t.skip(msg);
  }
  return pair;
}

test("sizeDiff: irreducible-loop-window round trip — ratio and histogram sum to function count", async (t) => {
  const pair = skipOrPair(t, "101-irreducible-loop-window");
  if (pair === null) return;
  const result = await sizeDiff(pair.original, pair.rebuilt);
  assert.ok(result.totals.original > 0);
  assert.ok(result.totals.rebuilt > 0);
  assert.equal(result.ratio, result.totals.rebuilt / result.totals.original);
  assert.ok(result.ratio > 0);
  assert.equal(result.functionCount, 4);
  const sum =
    result.histogram["reflect-apply"] + result.histogram["labelled-break"] + result.histogram["state-machine-switch"] + result.histogram.other;
  assert.equal(sum, result.functionCount);
  // This construct's `expandWindow`/`checkLo`/`checkHi` bodies call through
  // `Reflect.apply` (decompile()'s standard rendering of the computed
  // `globalThis.checkLo`/`checkHi` call targets, see the module doc comment)
  // -- known from having decompiled this fixture while writing the tool.
  assert.ok(result.histogram["reflect-apply"] >= 1, "expected at least one reflect-apply function");
});

test("sizeDiff: nested-closures-counters round trip — ratio and histogram sum to function count", async (t) => {
  const pair = skipOrPair(t, "22-nested-closures-counters");
  if (pair === null) return;
  const result = await sizeDiff(pair.original, pair.rebuilt);
  assert.equal(result.functionCount, 7);
  const sum =
    result.histogram["reflect-apply"] + result.histogram["labelled-break"] + result.histogram["state-machine-switch"] + result.histogram.other;
  assert.equal(sum, result.functionCount);
  assert.ok(result.ratio > 0);
});

test("sizeDiff: byModule/byFunction totals agree, unmatched rows counted not dropped", async (t) => {
  const pair = skipOrPair(t, "101-irreducible-loop-window");
  if (pair === null) return;
  const result = await sizeDiff(pair.original, pair.rebuilt);
  // No __d()/CJS wrapping in a plain hermesc-compiled construct fixture: every
  // function lands in the single `module: null` group (module doc comment).
  assert.equal(result.byModule.length, 1);
  assert.equal(result.byModule[0]?.originalModule, null);
  assert.equal(result.byModule[0]?.rebuiltModule, null);
  assert.equal(result.byModule[0]?.status, "matched");
  assert.equal(result.byModule[0]?.originalSize, result.totals.original);
  assert.equal(result.byModule[0]?.rebuiltSize, result.totals.rebuilt);
  // The decompiled form's extra top-level IIFE wrapper (module doc comment)
  // means the two sides' function counts differ, so at least one row is
  // unmatched on some side -- reported, not silently dropped.
  assert.ok(result.unmatched.originalOnly + result.unmatched.rebuiltOnly > 0);
  for (const row of result.byFunction) {
    if (row.original !== null && row.rebuilt !== null) assert.equal(row.delta, row.rebuilt.size - row.original.size);
    else assert.equal(row.delta, null);
  }
});

test("sizeDiff CLI: --json prints one object with totals/ratio/histogram/byModule/byFunction", (t) => {
  const pair = skipOrPair(t, "101-irreducible-loop-window");
  if (pair === null) return;
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-sizediff-cli-test-"));
  try {
    const originalPath = join(dir, "original.hbc");
    const rebuiltPath = join(dir, "rebuilt.hbc");
    writeFileSync(originalPath, pair.original);
    writeFileSync(rebuiltPath, pair.rebuilt);
    const r = spawnSync(process.execPath, [CLI, "sizediff", originalPath, rebuiltPath, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(typeof parsed.ratio, "number");
    assert.equal(typeof parsed.functionCount, "number");
    assert.ok(Array.isArray(parsed.byModule));
    assert.ok(Array.isArray(parsed.byFunction));
    assert.equal(
      parsed.histogram["reflect-apply"] + parsed.histogram["labelled-break"] + parsed.histogram["state-machine-switch"] + parsed.histogram.other,
      parsed.functionCount,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sizeDiff CLI: --by module prints human-readable module rows, exits 0", (t) => {
  const pair = skipOrPair(t, "101-irreducible-loop-window");
  if (pair === null) return;
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-sizediff-cli-human-test-"));
  try {
    const originalPath = join(dir, "original.hbc");
    const rebuiltPath = join(dir, "rebuilt.hbc");
    writeFileSync(originalPath, pair.original);
    writeFileSync(rebuiltPath, pair.rebuilt);
    const r = spawnSync(process.execPath, [CLI, "sizediff", originalPath, rebuiltPath, "--by", "module"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ratio:/);
    assert.match(r.stdout, /histogram:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sizeDiff CLI: unreadable input exits non-zero (could not measure, per the lane contract)", () => {
  const r = spawnSync(process.execPath, [CLI, "sizediff", "/no/such/original.hbc", "/no/such/rebuilt.hbc", "--json"], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
});
