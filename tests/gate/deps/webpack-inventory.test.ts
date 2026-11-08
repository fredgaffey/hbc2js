// docs/specs/32-webpack-inventory.md acceptance tests (docs/BUGS.md
// corpus-B4 shapes 3 and 4). Every bundle here is built at test time by
// hermesc from a small hand-written synthetic source: a Re.Pack/webpack
// chunk bundle, a webpack main runtime, a Metro bundle with an
// integer-keyed handler map, and a two-bundle APK.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildInventory } from "../../../src/deps/inventory.ts";
import { extractHermesBundlesFromApk, selectBundleInventory } from "../../../src/deps/bundles.ts";
import { runDeps } from "../../../src/deps/index.ts";
import { findHermesc, runHermesc } from "../../support/hermesc.ts";
import type { HbcVersion } from "../../support/hermesc.ts";

const CHUNK = `(self.webpackChunk_acme = self.webpackChunk_acme || []).push([[42], {
  1001: function (module, exports, __webpack_require__) { var a = __webpack_require__(7); module.exports = a + "wp-chunk-one"; },
  7: (e, t, n) => { "use strict"; n.r(t); t.default = n(1001) + n(300000) + n(1001); },
  300000: (e) => { e.exports = "wp-chunk-big-id"; },
}]);`;

const MAIN = `(() => {
  var __webpack_modules__ = ({
    10: (module, exports, __webpack_require__) => { module.exports = __webpack_require__(11) + "wp-main-ten"; },
    11: (module) => { module.exports = "wp-main-eleven"; },
  });
  var __webpack_module_cache__ = {};
  function __webpack_require__(moduleId) {
    var cached = __webpack_module_cache__[moduleId];
    if (cached !== undefined) return cached.exports;
    var module = __webpack_module_cache__[moduleId] = { exports: {} };
    __webpack_modules__[moduleId](module, module.exports, __webpack_require__);
    return module.exports;
  }
  __webpack_require__.m = __webpack_modules__;
  var chunkLoadingGlobal = self["webpackChunk_acme"] = self["webpackChunk_acme"] || [];
  chunkLoadingGlobal.push = function (data) { var more = data[1]; for (var id in more) __webpack_require__.m[id] = more[id]; };
  __webpack_require__(10);
})();`;

const FACTORY = "function(global, require, importDefault, importAll, module, exports, dependencyMap)";
const HANDLERS = `{ 0: function (a) { return a + 1; }, 1: function (a) { return a * 2; }, 2: (a, b, c) => c(3) }`;
const METRO_WITH_HANDLER_MAP = `var handlers = ${HANDLERS};
__d(${FACTORY} { var vt = ${HANDLERS}; module.exports = vt[0](handlers[1](2)) + "wp-metro-zero"; }, 0, []);
__d(${FACTORY} { module.exports = require(dependencyMap[0]) + "wp-metro-one"; }, 1, [0]);`;
const SCOPE_HOISTED = `var handlers = ${HANDLERS}; globalThis.run = function (k) { return handlers[k](1, 2, function (x) { return x; }); };`;
const CHUNK_TWO = `(self.webpackChunk_acme = self.webpackChunk_acme || []).push([[43], {
  12: (e, t, n) => { e.exports = n(10) + "wp-chunk-two"; },
}]);`;

const VERSIONS = ([94, 96, 98, 99] as HbcVersion[]).filter((v) => findHermesc(v) !== null);

function compileBytes(version: HbcVersion, dir: string, name: string, source: string): Uint8Array {
  const hermesc = findHermesc(version)!;
  writeFileSync(join(dir, `${name}.js`), source, "utf8");
  const outPath = join(dir, `${name}.hbc`);
  const r = runHermesc(hermesc, ["-O", "-emit-binary", `-out=${outPath}`, `${name}.js`], dir);
  assert.equal(r.status, 0, `hermesc v${version} failed: ${r.stderr}`);
  return new Uint8Array(readFileSync(outPath));
}

// A tiny v98 bundle passes verification under two opcode tables; the local
// v98 hermesc emits hbc98-late (as tests/gate/split/orphan-decl-order.test.ts).
function inventoryOf(version: HbcVersion, bytes: Uint8Array) {
  return buildInventory(bytes, version === 98 ? { opcodeTable: "hbc98-late" } : {}).inventory;
}

function withDir(fn: (dir: string) => void | Promise<void>): Promise<void> | void {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-webpack-inv-"));
  const done = () => rmSync(dir, { recursive: true, force: true });
  try {
    const r = fn(dir);
    if (r instanceof Promise) return r.finally(done);
    done();
  } catch (e) {
    done();
    throw e;
  }
}

function haveZip(): boolean {
  return spawnSync("zip", ["-v"], { stdio: "ignore" }).status === 0 && spawnSync("unzip", ["-v"], { stdio: "ignore" }).status === 0;
}

test("spec 32: webpack chunk bundle push([[ids], {id: factory}]) is a module inventory with ids and dep ids", (t) => {
  if (VERSIONS.length === 0) return t.skip("no hermesc found (run tools/get-hermesc.sh)");
  withDir((dir) => {
    for (const v of VERSIONS) {
      const inv = inventoryOf(v, compileBytes(v, dir, `chunk-${v}`, CHUNK));
      assert.equal(inv.bundleKind, "webpack", `v${v}`);
      const byId = new Map(inv.modules.map((m) => [m.localModuleId, m]));
      assert.deepEqual([...byId.keys()].sort((a, b) => a! - b!), [7, 1001, 300000], `v${v}`);
      assert.deepEqual(byId.get(1001)!.depIds, [7], `v${v}`);
      assert.deepEqual(byId.get(7)!.depIds, [1001, 300000], `v${v}: n.r(t) is not a dep, duplicates removed`);
      assert.deepEqual(byId.get(300000)!.depIds, [], `v${v}`);
      assert.ok(byId.get(1001)!.stringConstants.includes("wp-chunk-one"), `v${v}: module strings`);
    }
  });
});

test("spec 32: webpack main runtime's __webpack_modules__ object is a module inventory", (t) => {
  if (VERSIONS.length === 0) return t.skip("no hermesc found (run tools/get-hermesc.sh)");
  withDir((dir) => {
    for (const v of VERSIONS) {
      const inv = inventoryOf(v, compileBytes(v, dir, `main-${v}`, MAIN));
      assert.equal(inv.bundleKind, "webpack", `v${v}`);
      assert.deepEqual(inv.modules.map((m) => m.localModuleId), [10, 11], `v${v}`);
      assert.deepEqual(inv.modules.map((m) => m.depIds), [[11], []], `v${v}`);
    }
  });
});

test("spec 32: a handler-map object in a Metro bundle does not become modules", (t) => {
  if (VERSIONS.length === 0) return t.skip("no hermesc found (run tools/get-hermesc.sh)");
  withDir((dir) => {
    for (const v of VERSIONS) {
      const inv = inventoryOf(v, compileBytes(v, dir, `metro-${v}`, METRO_WITH_HANDLER_MAP));
      assert.equal(inv.bundleKind, "metro", `v${v}`);
      assert.deepEqual(inv.modules.map((m) => m.localModuleId), [0, 1], `v${v}`);
      assert.deepEqual(inv.modules.map((m) => m.depIds), [[], [0]], `v${v}`);
    }
  });
});

test("spec 32: a handler map in a bundle with no module system and no webpackChunk global is not a module inventory", (t) => {
  if (VERSIONS.length === 0) return t.skip("no hermesc found (run tools/get-hermesc.sh)");
  withDir((dir) => {
    for (const v of VERSIONS) {
      const inv = inventoryOf(v, compileBytes(v, dir, `hoisted-${v}`, SCOPE_HOISTED));
      assert.equal(inv.bundleKind, "none", `v${v}`);
      assert.equal(inv.modules.length, 0, `v${v}`);
    }
  });
});

test("spec 32: a webpack main bundle and its chunk bundles merge into one inventory; a Metro bundle is not merged", (t) => {
  if (VERSIONS.length === 0) return t.skip("no hermesc found (run tools/get-hermesc.sh)");
  withDir((dir) => {
    const v = VERSIONS[0]!;
    const main = compileBytes(v, dir, "m", MAIN);
    const chunk = compileBytes(v, dir, "c", CHUNK_TWO);
    const metro = compileBytes(v, dir, "x", METRO_WITH_HANDLER_MAP);
    const sel = selectBundleInventory([
      { entryPath: "assets/metro.bundle", bytes: metro },
      { entryPath: "assets/index.android.bundle", bytes: main },
      { entryPath: "assets/remote/43.chunk.bundle", bytes: chunk },
    ]);
    assert.equal(sel.inventory.bundleKind, "webpack");
    assert.deepEqual(sel.inventory.modules.map((m) => m.localModuleId), [10, 11, 12]);
    assert.deepEqual(sel.inventory.modules[2]!.depIds, [10]);
    const mainFns = buildInventory(main).inventory.totalFunctions;
    assert.equal(sel.inventory.totalFunctions, mainFns + buildInventory(chunk).inventory.totalFunctions);
    assert.ok(sel.inventory.modules[2]!.factoryFunctionIndex >= mainFns, "chunk function indices are offset past the main bundle's");
    assert.ok(sel.inventory.modules[2]!.stringConstants.includes("wp-chunk-two"));
    assert.deepEqual(sel.bundles.map((b) => [b.entryPath, b.kind, b.totalModules, b.analysed]), [
      ["assets/metro.bundle", "metro", 2, false],
      ["assets/index.android.bundle", "webpack", 2, true],
      ["assets/remote/43.chunk.bundle", "webpack", 1, true],
    ]);
  });
});

test("spec 32 / corpus-B4 shape 4: an APK whose first Hermes bundle has no modules analyses the sibling Metro bundle", async (t) => {
  if (VERSIONS.length === 0) return t.skip("no hermesc found (run tools/get-hermesc.sh)");
  if (!haveZip()) return t.skip("zip/unzip not on PATH");
  await withDir(async (dir) => {
    const v = VERSIONS[0]!;
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "PersonaCard.bundle"), compileBytes(v, dir, "hoisted", SCOPE_HOISTED));
    writeFileSync(join(dir, "assets", "foundation.android.bundle"), compileBytes(v, dir, "metro", METRO_WITH_HANDLER_MAP));
    const z = spawnSync("zip", ["-X", "test.apk", "assets/PersonaCard.bundle", "assets/foundation.android.bundle"], { cwd: dir, encoding: "utf8" });
    assert.equal(z.status, 0, z.stderr);
    const apk = join(dir, "test.apk");
    assert.deepEqual(extractHermesBundlesFromApk(apk).map((b) => b.entryPath), ["assets/PersonaCard.bundle", "assets/foundation.android.bundle"]);
    const run = await runDeps(apk, { offline: true, noSharedDb: true });
    assert.equal(run.report.totalModules, 2);
    assert.equal(run.inventory.bundleKind, "metro");
    assert.deepEqual(run.report.bundles?.map((b) => [b.entryPath, b.kind, b.totalModules, b.analysed]), [
      ["assets/PersonaCard.bundle", "none", 0, false],
      ["assets/foundation.android.bundle", "metro", 2, true],
    ]);
  });
});
