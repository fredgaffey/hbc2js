// `rn-flow/Libraries/Components/FlowToast.{ios,android.js}` differ only in
// their JSX color and return string (both are Flow+JSX, both would fail raw
// `hermesc` without the transform). `rn-flow/bundle-flow-source.js` is a
// synthetic Metro-shaped bundle (hand-written to look like ALREADY-Babel'd
// Metro output, the same convention `tests/fixtures/tooling/seams/
// bundle-source.js` uses) that bakes the ANDROID body into a bundle this
// test checks with `--platform ios` -- the seam this tool exists to find.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runSeams, type SeamsResult } from "../../../src/tooling/seams.ts";
import { findHermesc, runHermesc } from "../../support/hermesc.ts";
import { repoRoot } from "../../support/paths.ts";

const FIXTURE_DIR = join(repoRoot(), "tests", "fixtures", "tooling", "seams", "rn-flow");
const RN_DIR = join(FIXTURE_DIR, "Libraries", "Components");
const HERMESC_DIR = join(repoRoot(), "tools", "hermesc");

test("raw hermesc rejects the Flow+JSX RN-style source directly (the gap this item closes)", (t) => {
  const hermesc = findHermesc(99);
  if (hermesc === null) {
    t.skip("hermesc v99 not found (run tools/get-hermesc.sh 99)");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-seams-flow-raw-"));
  try {
    const flowSrc = readFileSync(join(RN_DIR, "FlowToast.ios.js"), "utf8");
    const wrapped = `__d(function(global, require, importDefault, importAll, module, exports, dependencyMap) {\n${flowSrc}\n}, 0, []);\n`;
    const srcPath = join(dir, "candidate.js");
    writeFileSync(srcPath, wrapped, "utf8");
    assert.throws(
      () => execFileSync(hermesc.path, ["-O", "-emit-binary", `-out=${join(dir, "candidate.hbc")}`, srcPath], { stdio: "pipe" }),
      "raw hermesc must reject Flow type syntax ('type ToastOptions = ...') without a Flow-strip transform first",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSeams classifies a Flow+JSX RN-style variant pair as a seam (needs the Babel transform stage)", async (t) => {
  if (findHermesc(99) === null) {
    t.skip("hermesc v99 not found (run tools/get-hermesc.sh 99)");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-seams-flow-"));
  try {
    const hermesc = findHermesc(99)!;
    const bundleSource = readFileSync(join(FIXTURE_DIR, "bundle-flow-source.js"), "utf8");
    writeFileSync(join(dir, "bundle-flow-source.js"), bundleSource, "utf8");
    const outPath = join(dir, "bundle.hbc");
    const r = runHermesc(hermesc, ["-O", "-emit-binary", `-out=${outPath}`, "bundle-flow-source.js"], dir);
    assert.equal(r.status, 0, `hermesc failed on the hand-written (already-Babel-shaped) bundle fixture: ${r.stderr}`);
    const bytes = new Uint8Array(readFileSync(outPath));

    const result: SeamsResult = await runSeams(bytes, { rnDir: RN_DIR, platform: "ios", hermescDir: HERMESC_DIR });
    assert.equal(result.variantModuleCount, 1, "exactly one FlowToast.{ios,android}.js pair");
    assert.equal(result.unclassifiable.length, 0, `expected the Flow+JSX variant to classify, got: ${JSON.stringify(result.unclassifiable)}`);
    assert.equal(result.seams.length, 1);
    const seam = result.seams[0]!;
    assert.equal(seam.name, "FlowToast");
    assert.equal(seam.matchedPlatform, "android");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
