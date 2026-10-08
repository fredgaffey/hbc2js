// Fixtures here are two small hand-written Metro-shaped bundles (real
// `__d(factory, id, deps)` registrations, compiled by hermesc so
// `buildInventoryFromModule`'s structural `__d()` scan finds them for
// real -- never a hand-faked ModuleInventory) with the SAME two modules
// (identified by their own distinct string literals -- "MODULE_A_MARKER"
// / "MODULE_B_MARKER") registered under SWAPPED local ids between the two
// sides, plus a third, unpaired module on one side only, plus two
// same-side modules sharing no distinguishing string literal at all (the
// collision case the brief calls out explicitly).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findHermesc, runHermesc } from "../../support/hermesc.ts";
import { requireOracles } from "../../support/tiers.ts";
import { sizeDiff } from "../../../src/tooling/sizediff.ts";

function compile(source: string): Uint8Array | null {
  const hermesc = findHermesc(99);
  if (hermesc === null) return null;
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-sizediff-module-corr-"));
  try {
    writeFileSync(join(dir, "input.js"), source);
    const out = join(dir, "out.hbc");
    const r = runHermesc(hermesc, ["-emit-binary", `-out=${out}`, "input.js"], dir);
    assert.equal(r.status, 0, `hermesc failed: ${r.stderr}`);
    return new Uint8Array(readFileSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function skipIfNoHermesc(t: import("node:test").TestContext): boolean {
  if (findHermesc(99) !== null) return false;
  const msg = "hermesc v99 not found (run tools/get-hermesc.sh 99)";
  if (requireOracles()) throw new Error(msg);
  t.skip(msg);
  return true;
}

function moduleFactory(marker: string, extraStatement: string): string {
  return (
    `function (global, require, importDefault, importAll, module, exports, dependencyMap) {\n` +
    `  var s = "${marker}";\n` +
    `  function helper() { return s.length${extraStatement}; }\n` +
    `  module.exports = helper();\n` +
    `}`
  );
}

// original: module 0 = A, module 1 = B (small).
// rebuilt:  module 0 = B (grown by one extra statement), module 1 = A
//           (byte-identical to original's A) -- ids permuted AND B's own
//           size genuinely changed, so a correct fix must both (a) pair A
//           with A / B with B despite the id swap and (b) report B's real
//           growth, not a delta manufactured by pairing A against B.
function permutedPair(): { readonly original: Uint8Array; readonly rebuilt: Uint8Array } | null {
  const originalSrc = `__d(${moduleFactory("MODULE_A_MARKER", "")}, 0, []);\n__d(${moduleFactory("MODULE_B_MARKER", "")}, 1, []);\n`;
  const rebuiltSrc = `__d(${moduleFactory("MODULE_B_MARKER", " + 1")}, 0, []);\n__d(${moduleFactory("MODULE_A_MARKER", "")}, 1, []);\n`;
  const original = compile(originalSrc);
  const rebuilt = compile(rebuiltSrc);
  if (original === null || rebuilt === null) return null;
  return { original, rebuilt };
}

test("sizeDiff --by module: permuted local ids still pair the same module correctly", async (t) => {
  const pair = permutedPair();
  if (pair === null) {
    skipIfNoHermesc(t);
    return;
  }
  const result = await sizeDiff(pair.original, pair.rebuilt);
  // Real `__d()` modules only -- the "not owned by any module" row for the
  // `global` function's own bytecode (the `__d(...)` call statements
  // themselves) is a separate, expected third row, not part of what this
  // test is about.
  const realModules = result.byModule.filter((m) => m.originalModule !== null || m.rebuiltModule !== null);
  assert.equal(realModules.length, 2, `expected exactly 2 real-module rows, got ${JSON.stringify(result.byModule)}`);

  const rowA = realModules.find((m) => m.originalModule === 0);
  const rowB = realModules.find((m) => m.originalModule === 1);
  assert.ok(rowA !== undefined, "expected a row for original module 0 (A)");
  assert.ok(rowB !== undefined, "expected a row for original module 1 (B)");

  // A: original local id 0, rebuilt local id 1 (swapped) -- byte-identical
  // factory on both sides, so delta must be exactly 0. The pre-fix code
  // would instead pair original-0 with rebuilt-0 (B, grown), reporting a
  // large positive delta for what is actually an unchanged module.
  assert.equal(rowA?.status, "matched");
  assert.equal(rowA?.rebuiltModule, 1, "module A must be paired with rebuilt id 1, not rebuilt id 0");
  assert.equal(rowA?.delta, 0, "module A's own bytes are unchanged between the two sides");

  // B: original local id 1, rebuilt local id 0 (swapped) -- genuinely
  // grew by one extra statement. The pre-fix code would instead pair
  // original-1 with rebuilt-1 (A, unchanged), reporting delta 0 for a
  // module that actually grew.
  assert.equal(rowB?.status, "matched");
  assert.equal(rowB?.rebuiltModule, 0, "module B must be paired with rebuilt id 0, not rebuilt id 1");
  assert.ok((rowB?.delta ?? 0) > 0, `module B genuinely grew; expected delta > 0, got ${rowB?.delta}`);

  assert.equal(result.unmatchedModules.originalOnly, 0);
  assert.equal(result.unmatchedModules.rebuiltOnly, 0);
  assert.equal(result.unmatchedModules.ambiguous, 0);
});

test("sizeDiff --by module: a module present on only one side is reported explicitly, never dropped", async (t) => {
  if (skipIfNoHermesc(t)) return;
  const originalSrc = `__d(${moduleFactory("MODULE_A_MARKER", "")}, 0, []);\n__d(${moduleFactory("MODULE_C_ONLY_ON_ORIGINAL", "")}, 1, []);\n`;
  const rebuiltSrc = `__d(${moduleFactory("MODULE_A_MARKER", "")}, 0, []);\n`;
  const original = compile(originalSrc);
  const rebuilt = compile(rebuiltSrc);
  assert.ok(original !== null && rebuilt !== null);
  const result = await sizeDiff(original!, rebuilt!);

  const rowA = result.byModule.find((m) => m.status === "matched" && (m.originalModule !== null || m.rebuiltModule !== null));
  assert.ok(rowA !== undefined);
  assert.equal(rowA?.delta, 0);

  const unmatchedRow = result.byModule.find((m) => m.status === "original-only");
  assert.ok(unmatchedRow !== undefined, `expected an explicit original-only row, got ${JSON.stringify(result.byModule)}`);
  assert.equal(unmatchedRow?.rebuiltModule, null);
  assert.ok((unmatchedRow?.originalSize ?? 0) > 0);
  assert.equal(result.unmatchedModules.originalOnly, 1);
  assert.equal(result.unmatchedModules.rebuiltOnly, 0);
});

test("sizeDiff --by module: two same-side modules with an identical string set collide honestly, never silently paired", async (t) => {
  if (skipIfNoHermesc(t)) return;
  // Two modules on the SAME (original) side sharing the exact same string
  // literal (and thus the exact same content-identity key this tool now
  // keys on) -- deliberately the collision hazard the brief calls out:
  // this must surface as an explicit "ambiguous" status, never a silent
  // guess pairing one of them to whichever single counterpart exists on
  // the other side.
  const originalSrc = `__d(${moduleFactory("SHARED_MARKER", "")}, 0, []);\n__d(${moduleFactory("SHARED_MARKER", " + 1")}, 1, []);\n`;
  const rebuiltSrc = `__d(${moduleFactory("SHARED_MARKER", "")}, 0, []);\n`;
  const original = compile(originalSrc);
  const rebuilt = compile(rebuiltSrc);
  assert.ok(original !== null && rebuilt !== null);
  const result = await sizeDiff(original!, rebuilt!);

  const matched = result.byModule.filter((m) => m.status === "matched" && (m.originalModule !== null || m.rebuiltModule !== null));
  assert.equal(matched.length, 0, "an ambiguous identity must never be silently paired");
  const ambiguous = result.byModule.filter((m) => m.status === "ambiguous");
  // All THREE rows sharing this identity are ambiguous: the two colliding
  // original-side modules, AND the single rebuilt-side module -- pairing
  // that lone rebuilt module with either one of the two originals would
  // still be a guess (there is no way to tell which), so it is reported
  // ambiguous too, never silently paired to "whichever happened to be the
  // only one on its own side".
  assert.equal(ambiguous.length, 3, `expected all 3 same-identity modules reported ambiguous, got ${JSON.stringify(result.byModule)}`);
  assert.equal(result.unmatchedModules.ambiguous, 3);
  // Every function belonging to an ambiguous module still shows up in
  // byFunction, unmatched -- counted, never dropped from the table.
  for (const row of result.byFunction) {
    if (row.originalModule === 0 || row.originalModule === 1) assert.equal(row.rebuilt, null);
  }
});
