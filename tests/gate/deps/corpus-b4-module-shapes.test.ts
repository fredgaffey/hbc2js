// corpus-B4 (docs/BUGS.md): real Metro bundles reported `totalModules: 0`
// because dscan.ts only recognised `__d(factory, id, deps)` calls made
// directly in the global function (index 0) through a global literally
// named `__d`. Two shapes seen in the real-world corpus, reproduced here
// with hand-written synthetic sources:
//   1. A `__METRO_GLOBAL_PREFIX__` build (`<prefix>__d`) whose whole body is
//      wrapped in an IIFE, so the registrations live in function 1.
//   2. Lazy module definition: a function created by the global function
//      switches on a module id and calls `__d(factory, id)` (two arguments,
//      Call3), one case per module.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildInventory } from "../../../src/deps/inventory.ts";
import { findHermesc, runHermesc } from "../../support/hermesc.ts";
import type { HbcVersion } from "../../support/hermesc.ts";

const FACTORY = "function(global, require, importDefault, importAll, module, exports, dependencyMap)";

const PREFIXED_IIFE = `(function () {
  __acme_app__d(${FACTORY} { module.exports = "corpus-b4-one"; }, 0, []);
  __acme_app__d(${FACTORY} { module.exports = require(dependencyMap[0]) + "-two"; }, 1, [0]);
  __acme_app__d(${FACTORY} { module.exports = function three() { return "corpus-b4-three"; }; }, 2, [0, 1]);
})();`;

const LAZY_SWITCH = `function defineModule(id) {
  switch (id) {
    case 0: __d(${FACTORY} { module.exports = "corpus-b4-lazy-zero"; }, 0); return;
    case 1: __d(${FACTORY} { module.exports = "corpus-b4-lazy-one" + id; }, 1); return;
    case 7: __d(${FACTORY} { module.exports = { seven: "corpus-b4-lazy-seven" }; }, 7); return;
  }
  throw new Error("No module found for ID " + id);
}
globalThis.__registerLazyModules(defineModule);
__r(0);`;

const PLAIN = `__d(${FACTORY} { module.exports = "corpus-b4-plain"; }, 0, []);
__d(${FACTORY} { module.exports = { notARegistration: globalThis.foo__dx }; }, 1, [0]);`;

function compile(version: HbcVersion, dir: string, name: string, source: string) {
  const hermesc = findHermesc(version)!;
  writeFileSync(join(dir, `${name}.js`), source, "utf8");
  const outPath = join(dir, `${name}.hbc`);
  const r = runHermesc(hermesc, ["-O", "-emit-binary", `-out=${outPath}`, `${name}.js`], dir);
  assert.equal(r.status, 0, `hermesc v${version} failed: ${r.stderr}`);
  // A tiny v98 bundle passes verification under two opcode tables; the local
  // v98 hermesc emits hbc98-late (as tests/gate/split/orphan-decl-order.test.ts).
  return buildInventory(new Uint8Array(readFileSync(outPath)), version === 98 ? { opcodeTable: "hbc98-late" } : {}).inventory;
}

const VERSIONS = ([94, 96, 98, 99] as HbcVersion[]).filter((v) => findHermesc(v) !== null);

test("corpus-B4: prefixed __d inside an IIFE wrapper is a module inventory", (t) => {
  if (VERSIONS.length === 0) return t.skip("no hermesc found (run tools/get-hermesc.sh)");
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-corpus-b4-"));
  try {
    for (const v of VERSIONS) {
      const inv = compile(v, dir, `prefixed-${v}`, PREFIXED_IIFE);
      assert.deepEqual(inv.modules.map((m) => m.localModuleId), [0, 1, 2], `v${v}`);
      assert.deepEqual(inv.modules.map((m) => m.depIds), [[], [0], [0, 1]], `v${v}`);
      assert.ok(inv.modules[2]!.nestedFunctionIndices.length === 1, `v${v}: module 2's nested closure`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corpus-B4: lazy switch of two-argument __d(factory, id) calls is a module inventory", (t) => {
  if (VERSIONS.length === 0) return t.skip("no hermesc found (run tools/get-hermesc.sh)");
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-corpus-b4-"));
  try {
    for (const v of VERSIONS) {
      const inv = compile(v, dir, `lazy-${v}`, LAZY_SWITCH);
      assert.deepEqual(inv.modules.map((m) => m.localModuleId).sort((a, b) => a! - b!), [0, 1, 7], `v${v}`);
      for (const m of inv.modules) {
        assert.equal(m.depIds, null, `v${v}: two-argument __d carries no deps array`);
        assert.ok(m.stringConstants.some((s) => s.startsWith("corpus-b4-lazy")), `v${v}: module ${m.localModuleId} strings`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corpus-B4: plain top-level __d bundle is unchanged (no extra modules from nested functions)", (t) => {
  if (VERSIONS.length === 0) return t.skip("no hermesc found (run tools/get-hermesc.sh)");
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-corpus-b4-"));
  try {
    for (const v of VERSIONS) {
      const inv = compile(v, dir, `plain-${v}`, PLAIN);
      assert.deepEqual(inv.modules.map((m) => m.localModuleId), [0, 1], `v${v}`);
      assert.deepEqual(inv.modules.map((m) => m.depIds), [[], [0]], `v${v}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
