// rebuild-paths (docs/PACKAGE-SIGNATURES.md §7 "Rebuilding a DB with
// paths"): the pure parts of tools/pkgsig/bulk/transplant-multi.mjs —
// job grouping (one Metro bundle per package@version per RN family) and
// the old-file path transplant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSigFileName, planJobs, transplantPaths } from "../../../tools/pkgsig/bulk/transplant-lib.mjs";

test("rebuild-paths: planJobs groups one bundle per package@version per RN family, skips done files", () => {
  const names = ["@scope__a@1.0.0__hbc98.json", "@scope__a@1.0.0__hbc99.json", "@scope__a@1.0.0__hbc94.json", "@scope__a@1.0.0__hbc96.json", "b@2.1.0__hbc99.json", "b@2.1.0__hbc98.json", "c@0.1.0__hbc90.json", "README.md"];
  assert.deepEqual(parseSigFileName("@scope__a@1.0.0__hbc98.json"), { pkgVer: "@scope__a@1.0.0", hbc: 98 });
  assert.equal(parseSigFileName("README.md"), null);
  assert.deepEqual(planJobs(names, new Set(["b@2.1.0__hbc98.json"])), [
    { family: "87", pkgVer: "@scope__a@1.0.0", files: ["@scope__a@1.0.0__hbc98.json", "@scope__a@1.0.0__hbc99.json"] },
    { family: "87", pkgVer: "b@2.1.0", files: ["b@2.1.0__hbc99.json"] },
    { family: "72", pkgVer: "@scope__a@1.0.0", files: ["@scope__a@1.0.0__hbc94.json", "@scope__a@1.0.0__hbc96.json"] },
  ]);
  assert.deepEqual(planJobs(["b@2.1.0__hbc99.json"], new Set(["b@2.1.0__hbc99.json"])), [], "fully done: no job");
});

test("rebuild-paths: transplantPaths matches by id+hash, else unique hash; ambiguous or missing stays neutral", () => {
  const old = {
    modules: [{ localModuleId: 0, factoryExactHash: "A" }, { localModuleId: 1, factoryExactHash: "B" }, { localModuleId: 2, factoryExactHash: "C" }, { localModuleId: 3, factoryExactHash: "D" }],
    functions: [{ index: 0, exactHash: "fa" }, { index: 1, exactHash: "fb" }, { index: 2, exactHash: "fd" }, { index: 3, exactHash: "fz", moduleId: 9 }],
  };
  const fresh = {
    // ids shifted by one for B; C appears twice (ambiguous); D absent
    modules: [{ localModuleId: 0, factoryExactHash: "A", path: "p/a.js" }, { localModuleId: 5, factoryExactHash: "B", path: "q/b.js" }, { localModuleId: 6, factoryExactHash: "C", path: "x.js" }, { localModuleId: 7, factoryExactHash: "C", path: "y.js" }],
    functions: [{ index: 0, exactHash: "fa", moduleId: 0 }, { index: 9, exactHash: "fb", moduleId: 5 }, { index: 2, exactHash: "fd", moduleId: 7 }],
  };
  const t = transplantPaths(old, fresh);
  assert.deepEqual(t.modules.map((m) => m.path), ["p/a.js", "q/b.js", null, null]);
  assert.deepEqual(t.functions.map((f) => f.moduleId), [0, 1, undefined, undefined], "fb follows B's id remap; fd's module unmatched; a stale moduleId is dropped");
  assert.equal(t.modMiss, 2);
  assert.equal(t.fnMiss, 2);
  assert.equal(t.ok, true, "half unmatched is still written");
  assert.equal(transplantPaths({ modules: old.modules, functions: [] }, { modules: fresh.modules.slice(0, 1), functions: [] }).ok, false, "more than half unmatched: not written");
});
