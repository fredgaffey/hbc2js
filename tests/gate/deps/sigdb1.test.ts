// SIGDB1: an explicit `--sigdb <dir>` (possibly the huge bulk DB) must honour
// the evidence-directed candidate filter; the genuine project layer
// (`<out>/.hbc2js/sigdb`, this project's own --confirm output) still loads in full.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDbLayers, loadSignatures } from "../../../src/deps/db.ts";

function makeDb(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const [pkg, ver] of [["cand-pkg", "1.0.0"], ["other-pkg", "2.0.0"]] as const) {
    writeFileSync(join(dir, `${pkg}@${ver}__hbc96.json`), JSON.stringify({
      schema: 2, package: pkg, version: ver, hbcVersion: 96, totalFunctions: 1, rawFunctionCount: 1,
      subtractedBaselines: [], functions: [], modules: [], toolchainBaseline: false,
      provenance: { packageSha256: null, metroVersion: null, reactNativeVersion: null, hermescVersion: 96, hermescRnEra: null, repoCommit: null, builtAt: "2026-01-01" },
    }));
  }
}

test("SIGDB1: --sigdb layer honours the candidate filter; the project (--out) layer still loads in full", () => {
  const root = mkdtempSync(join(tmpdir(), "hbc2js-sigdb1-"));
  const sigdb = join(root, "big");
  makeDb(sigdb);
  const candidates = new Set(["cand-pkg"]);
  const viaSigdb = loadSignatures(resolveDbLayers({ sigdb, noSharedDb: true }), { candidates })
    .filter((s) => s.path.startsWith(sigdb)).map((s) => s.file.package).sort();
  assert.deepEqual(viaSigdb, ["cand-pkg"]);

  const out = join(root, "out");
  makeDb(join(out, ".hbc2js", "sigdb"));
  const viaOut = loadSignatures(resolveDbLayers({ outDir: out, noSharedDb: true }), { candidates })
    .filter((s) => s.path.startsWith(out)).map((s) => s.file.package).sort();
  assert.deepEqual(viaOut, ["cand-pkg", "other-pkg"]);
});
