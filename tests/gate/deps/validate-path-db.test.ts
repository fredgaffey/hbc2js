// tools/pkgsig/ship/validate-path-db.mjs on a tiny synthetic path DB.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateDb } from "../../../tools/pkgsig/ship/validate-path-db.mjs";

const sig = (extra: object) => JSON.stringify({ schema: 2, hashScheme: 2, hbcVersion: 99, functions: [], modules: [], ...extra });

test("validate-path-db: coverage, pathless and consistency on a synthetic DB", () => {
  const root = mkdtempSync(join(tmpdir(), "vpd-"));
  try {
    const src = join(root, "src"), out = join(root, "out"), bad = join(root, "bad");
    for (const d of [src, out, bad]) mkdirSync(d);
    const good = sig({ package: "a", version: "1.0.0", modulePaths: 1,
      modules: [{ localModuleId: 0, path: "a/index.js" }, { localModuleId: 1, path: null }],
      functions: [{ index: 0, moduleId: 0 }, { index: 1, moduleId: 1 }, { index: 2 }] });
    writeFileSync(join(out, "a@1.0.0__hbc99.json"), good);
    writeFileSync(join(src, "a@1.0.0__hbc99.json"), sig({ package: "a", version: "1.0.0" }));
    writeFileSync(join(src, "b@2.0.0__hbc99.json"), sig({ package: "b", version: "2.0.0" }));
    const r = validateDb(out, { src });
    assert.equal(r.ok, true);
    assert.equal(r.withPaths, 1);
    assert.equal(r.modulePathCoveragePct, 50);
    assert.equal(r.functionModuleIdCoveragePct, 66.7);
    assert.deepEqual(r.missingFromOut, ["b@2.0.0__hbc99.json"]);
    assert.deepEqual(r.schemes, { 2: 1 });
    writeFileSync(join(bad, "c@1.0.0__hbc99.json"), sig({ package: "c", version: "1.0.0", modulePaths: 1,
      modules: [{ localModuleId: 0, path: "/abs/x.js" }], functions: [{ index: 0, moduleId: 7 }] }));
    writeFileSync(join(bad, "d@1.0.0__hbc99.json"), "{oops");
    writeFileSync(join(bad, "e@1.0.0__hbc99.json"), sig({ package: "e", version: "1.0.0" }));
    const b = validateDb(bad);
    assert.equal(b.ok, false);
    assert.equal(b.parseErrors, 1);
    assert.equal(b.errors.length, 3, b.errors.join("|"));
    assert.deepEqual(b.pathless, ["e@1.0.0__hbc99.json"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
