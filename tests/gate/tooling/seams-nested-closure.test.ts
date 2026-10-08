import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSeams, type SeamsResult } from "../../../src/tooling/seams.ts";
import { findHermesc, runHermesc } from "../../support/hermesc.ts";
import { repoRoot } from "../../support/paths.ts";

const FIXTURE_DIR = join(repoRoot(), "tests", "fixtures", "tooling", "seams", "nested-only");
const RN_DIR = join(FIXTURE_DIR, "Libraries");
const HERMESC_DIR = join(repoRoot(), "tools", "hermesc");

function compileBundle(dir: string): Uint8Array {
  const hermesc = findHermesc(99);
  if (hermesc === null) throw new Error("hermesc v99 required — caller must check findHermesc first");
  const source = readFileSync(join(FIXTURE_DIR, "bundle-source.js"), "utf8");
  writeFileSync(join(dir, "bundle-source.js"), source, "utf8");
  const outPath = join(dir, "bundle.hbc");
  const r = runHermesc(hermesc, ["-O", "-emit-binary", `-out=${outPath}`, "bundle-source.js"], dir);
  assert.equal(r.status, 0, `hermesc failed: ${r.stderr}`);
  return new Uint8Array(readFileSync(outPath));
}

test("runSeams matches a bundle module to its variant even when the factory-level export wrapper differs (G1b: nested-closure-only hashing)", async (t) => {
  if (findHermesc(99) === null) {
    t.skip("hermesc v99 not found (run tools/get-hermesc.sh 99)");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-seams-nested-test-"));
  try {
    const bytes = compileBundle(dir);
    const result: SeamsResult = await runSeams(bytes, { rnDir: RN_DIR, platform: "ios", hermescDir: HERMESC_DIR });
    assert.equal(result.variantModuleCount, 1, "exactly one Toggle.{ios,android}.js pair");
    assert.equal(
      result.unclassifiable.length,
      0,
      `expected the android body to be matched despite the differing factory wrapper; got unclassifiable: ${JSON.stringify(result.unclassifiable, null, 2)}`,
    );
    assert.equal(result.seams.length, 1);
    const seam = result.seams[0]!;
    assert.equal(seam.name, "Toggle");
    assert.equal(seam.matchedPlatform, "android");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
