import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSeams, type SeamsResult } from "../../../src/tooling/seams.ts";
import { findHermesc, runHermesc } from "../../support/hermesc.ts";
import { repoRoot } from "../../support/paths.ts";

const FIXTURE_DIR = join(repoRoot(), "tests", "fixtures", "tooling", "seams");
const RN_DIR = join(FIXTURE_DIR, "rn");
const HERMESC_DIR = join(repoRoot(), "tools", "hermesc");

function compile(source: string, dir: string): Uint8Array {
  const hermesc = findHermesc(99);
  if (hermesc === null) throw new Error("hermesc v99 required — caller must check findHermesc first");
  writeFileSync(join(dir, "bundle-source.js"), source, "utf8");
  const outPath = join(dir, "bundle.hbc");
  const r = runHermesc(hermesc, ["-O", "-emit-binary", `-out=${outPath}`, "bundle-source.js"], dir);
  assert.equal(r.status, 0, `hermesc failed: ${r.stderr}`);
  return new Uint8Array(readFileSync(outPath));
}

test("runSeams flags the wrong-platform variant baked into the bundle, and classifies the neutral module as neutral", async (t) => {
  if (findHermesc(99) === null) {
    t.skip("hermesc v99 not found (run tools/get-hermesc.sh 99)");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-seams-test-"));
  try {
    const bundleSource = readFileSync(join(FIXTURE_DIR, "bundle-source.js"), "utf8");
    const bytes = compile(bundleSource, dir);
    const result: SeamsResult = await runSeams(bytes, { rnDir: RN_DIR, platform: "ios", hermescDir: HERMESC_DIR });
    assert.equal(result.platform, "ios");
    assert.equal(result.bundleModuleCount, 2);
    assert.equal(result.variantModuleCount, 1, "exactly one Toast.{ios,android}.js pair");
    assert.equal(result.neutralModuleCount, 1, "Alert.js has no platform variant");
    assert.equal(result.unclassifiable.length, 0);
    assert.equal(result.seams.length, 1);
    const seam = result.seams[0]!;
    assert.equal(seam.name, "Toast");
    assert.equal(seam.matchedPlatform, "android");
    assert.equal(seam.matchTier, "exact");
    assert.equal(seam.bundleModuleId, 0);
    assert.equal(result.totals.seams, 1);
    assert.equal(result.totals.unclassifiable, 0);
    assert.equal(result.hermescSource, "found");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSeams reports no seam when the correct platform's variant is baked in", async (t) => {
  if (findHermesc(99) === null) {
    t.skip("hermesc v99 not found (run tools/get-hermesc.sh 99)");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-seams-test-"));
  try {
    // G1 (block-2026-09-23-next.md): must match the SAME minified shape
    // `runSeams`'s own candidate pipeline now produces for this exact file
    // (`metro-transform-worker`, `minify: true`) -- a hand-written
    // unminified body no longer fuzzy-matches a minified candidate at all
    // (control-flow gets restructured, not just renamed), so this is the
    // real transform's actual output for Toast.android.js, not hand-authored.
    const src = '__d(function(g,r,i,a,m,e,d){m.exports=function(n){return n?"TOAST["+n+"]":"TOAST[]"}}, 0, []);';
    const bytes = compile(src, dir);
    const result = await runSeams(bytes, { rnDir: RN_DIR, platform: "android", hermescDir: HERMESC_DIR });
    assert.equal(result.seams.length, 0);
    assert.equal(result.unclassifiable.length, 0);
    assert.equal(result.variantModuleCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSeams reports a missing hermesc as unclassifiable, never as a false seam", async (t) => {
  if (findHermesc(99) === null) {
    t.skip("hermesc v99 not found (run tools/get-hermesc.sh 99)");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-seams-test-"));
  try {
    const src = "__d(function(global, require, importDefault, importAll, module, exports, dependencyMap) { module.exports = 1; }, 0, []);";
    const bytes = compile(src, dir);
    const result = await runSeams(bytes, { rnDir: RN_DIR, platform: "ios", hermescDir: join(FIXTURE_DIR, "no-such-hermesc-dir") });
    assert.equal(result.seams.length, 0);
    assert.equal(result.unclassifiable.length, 1);
    assert.match(result.unclassifiable[0]!.reason, /hermesc v99 not available/);
    assert.match(result.hermescSource, /^missing-hermesc-v99$/);
    assert.equal(result.hermescPath, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
