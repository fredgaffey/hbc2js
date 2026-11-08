// corpus-path-recall (docs/PACKAGE-SIGNATURES.md §7 "Recovery through the
// module graph", docs/DEPS.md "Path recall"): with path-bearing signatures
// a package is scored on its own files only, so a true package whose own
// file is small, or compiled differently from the signature, while the
// dependency it requires is a confirmed package, is lost
// (abort-controller -> event-target-shim, hoist-non-react-statics ->
// react-is on react-navigation-example and bluesky). The evidence that
// brings it back is an edge in the app's module graph: a module shaped like
// the package's own file that requires the dependency's module. The
// safe-buffer false positive (an impostor whose own file is not in the app,
// matched only through its copy of `buffer`) has no such module and stays
// refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireHermesc } from "../../support/hermesc.ts";
import { buildInventory } from "../../../src/deps/inventory.ts";
import { matchInventory } from "../../../src/deps/match.ts";
import { fingerprintModule, SIG_HASH_SCHEME } from "../../../src/deps/fingerprint.ts";
import { decodeFunction } from "../../../src/disasm/decode.ts";
import { parseHbc } from "../../../src/parse/module.ts";
import { attachModulePaths } from "../../../src/deps/module-paths.ts";
import { slimSigFile, slimTargetFor } from "../../../src/deps/slim-sigs.ts";
import type { LoadedSig } from "../../../src/deps/db.ts";
import type { SigDbFile } from "../../../src/deps/sigdb-types.ts";

const HEAD = "function __d(factory, moduleId, deps) {}";
const FN = "function (global, require, importDefault, exportAll, module, exports, dependencyMap)";
// Module i is registered with id i and the given dependency ids.
const bundle = (mods: readonly { body: string; deps?: readonly number[] }[]): string =>
  [HEAD, ...mods.map((m, id) => `__d(${FN}{${m.body}},${id},[${(m.deps ?? []).join(",")}]);`)].join("\n") + "\n";

const helpers = (tag: string, n: number, seed: number): string[] =>
  Array.from({ length: n }, (_, i) => `function ${tag}${i}(x, y) { var t = ${seed + i}; for (var k = 0; k < x; k++) { t = (t * ${31 + i} + k * y - (k % ${3 + i})) % ${1000003 + seed}; if (t > ${500 + i}) t = t - y; } return t + "${tag}${i}".length; }`);
const fnNames = (tag: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${tag}${i}`);
const exportAll = (names: readonly string[]): string => `module.exports = { ${names.map((n) => `${n}: ${n}`).join(", ")} };`;
const moduleOf = (tag: string, n: number, seed: number): string => helpers(tag, n, seed).join("\n") + "\n" + exportAll(fnNames(tag, n));
// A wrapper's own file: its helpers use the required dependency.
const wrapperOf = (tag: string, n: number, seed: number): string =>
  `var dep = require(dependencyMap[0]);\n` +
  // Each helper a different statement count, so a distinct mnemonic shape.
  Array.from({ length: n }, (_, i) => `function ${tag}${i}(x) { var r = dep.d0(x, ${seed + i}); for (var j = 0; j < ${3 + i}; j++) { ${"r = r + dep.d1(j, x) * 7; ".repeat(i + 1)}} return r + "${tag}${i}".length; }`).join("\n") +
  "\n" + exportAll(fnNames(tag, n));

function compile(hermesc: string, js: string): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-path-recall-"));
  try {
    execFileSync(hermesc, ["-O", "-emit-binary", `-out=${join(dir, "o.hbc")}`, "-"], { input: js });
    return new Uint8Array(readFileSync(join(dir, "o.hbc")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function signature(hermesc: string, pkg: string, mods: readonly { body: string; deps?: readonly number[]; path: string | null }[]): SigDbFile {
  const mod = parseHbc(compile(hermesc, bundle(mods)));
  const fp = fingerprintModule(mod, decodeFunction);
  const paths = new Map(mods.map((m, id) => [id, m.path]));
  const attached = attachModulePaths(mod, decodeFunction, fp.functions, fp.modules, paths);
  const functions = attached.functions;
  const modules = attached.modules.map(({ nestedFunctionIndices: _n, ...m }) => m);
  return {
    schema: 2, hashScheme: SIG_HASH_SCHEME, package: pkg, version: "1.0.0", hbcVersion: mod.header.version,
    totalFunctions: fp.functions.length, rawFunctionCount: fp.functions.length, subtractedBaselines: [], functions, modules, toolchainBaseline: false,
    provenance: { packageSha256: null, metroVersion: null, reactNativeVersion: null, hermescVersion: mod.header.version, hermescRnEra: null, repoCommit: null, builtAt: "2026-11-09T00:00:00.000Z" },
    modulePaths: 1,
  };
}

const loaded = (files: readonly SigDbFile[]): LoadedSig[] => files.map((file) => ({ file, layer: "shared", path: `<${file.package}>` }));
const scoreOf = (report: ReturnType<typeof matchInventory>, p: string) => report.packages.find((s) => s.package === p);
// The real pipeline loads slimmed records (deps-slim-sigs); the rule must
// judge them exactly as the full files.
function matchBoth(target: ReturnType<typeof buildInventory>["inventory"], files: readonly SigDbFile[]): ReturnType<typeof matchInventory> {
  const full = matchInventory(target, loaded(files));
  const intern = new Map<string, string>();
  const slim = matchInventory(target, loaded(files.map((f) => slimSigFile(f, intern, slimTargetFor(target)))));
  assert.deepEqual(slim.packages, full.packages.map((p) => ({ ...p })), "slimmed records score the same");
  return full;
}
const APP = `var c = 1; for (var w = 0; w < 19; w++) { c = (c * 31 + w) % 1000003; } module.exports = function appOnly(v) { return c ^ v; };`;
const DEP = moduleOf("d", 6, 900); // the dependency: six helpers, confirmed on its own

test("corpus-path-recall: a wrapper whose own file is compiled differently is confirmed through its edge to a confirmed dependency", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  const dep = signature(h.path, "dep-d", [{ body: DEP, path: "dep-d/index.js" }]);
  // The signature's own file (wrap-p/index.js) requires its own copy of dep-d.
  const wrap = signature(h.path, "wrap-p", [{ body: wrapperOf("wp", 4, 10), deps: [1], path: "wrap-p/index.js" }, { body: DEP, path: "dep-d/index.js" }]);
  // The app's copy: the same code built differently (other names and
  // literals, so no exact hash matches, mnemonics unchanged), requiring
  // the app's dep-d module.
  const target = buildInventory(compile(h.path, bundle([{ body: APP }, { body: DEP }, { body: wrapperOf("wq", 4, 10), deps: [1] }]))).inventory;
  const report = matchBoth(target, ([dep, wrap]));
  assert.equal(scoreOf(report, "dep-d")?.tier, "high", "the dependency is confirmed on its own code");
  assert.equal(scoreOf(report, "wrap-p")?.exactHits, 0, "no own-file exact hit");
  assert.equal(scoreOf(report, "wrap-p")?.tier, "high", `the module-graph edge confirms the wrapper: ${JSON.stringify(scoreOf(report, "wrap-p"))}`);
  assert.deepEqual(scoreOf(report, "wrap-p")?.viaDependency, { by: "dep-d", edge: "fuzzy" });
});

test("corpus-path-recall: the same wrapper-shaped module without the edge to the dependency is not the package", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  const dep = signature(h.path, "dep-d", [{ body: DEP, path: "dep-d/index.js" }]);
  const wrap = signature(h.path, "wrap-p", [{ body: wrapperOf("wp", 4, 10), deps: [1], path: "wrap-p/index.js" }, { body: DEP, path: "dep-d/index.js" }]);
  // The wrapper-shaped module requires an app module, not dep-d's.
  const target = buildInventory(compile(h.path, bundle([{ body: APP }, { body: DEP }, { body: wrapperOf("wq", 4, 10), deps: [0] }]))).inventory;
  const report = matchBoth(target, ([dep, wrap]));
  assert.equal(scoreOf(report, "dep-d")?.tier, "high");
  assert.notEqual(scoreOf(report, "wrap-p")?.tier, "high", JSON.stringify(scoreOf(report, "wrap-p")));
});

test("corpus-path-recall: an impostor matched only through its copy of a confirmed dependency stays refused (safe-buffer)", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  const dep = signature(h.path, "dep-d", [{ body: DEP, path: "dep-d/index.js" }]);
  // Like safe-buffer: its own file is not in the app; its signature holds a
  // copy of the dependency (buffer) the app does have, and app modules
  // require that dependency.
  const impostor = signature(h.path, "impostor-s", [{ body: wrapperOf("im", 4, 70), deps: [1], path: "impostor-s/index.js" }, { body: DEP, path: "dep-d/index.js" }]);
  const appUser = `var dep = require(dependencyMap[0]); module.exports = function useDep(v) { return dep.d0(v, 3) + dep.d2(v, 4); };`;
  const target = buildInventory(compile(h.path, bundle([{ body: APP }, { body: DEP }, { body: appUser, deps: [1] }]))).inventory;
  const report = matchBoth(target, ([dep, impostor]));
  assert.equal(scoreOf(report, "dep-d")?.tier, "high");
  assert.notEqual(scoreOf(report, "impostor-s")?.tier, "high", JSON.stringify(scoreOf(report, "impostor-s")));
  assert.equal(scoreOf(report, "impostor-s")?.viaDependency, undefined);
});

test("corpus-path-recall: a small own file fully present, requiring the dependency's exact module, is confirmed (hoist-non-react-statics)", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  // Like hoist-non-react-statics -> its nested react-is: three own
  // functions, below the tiny-package bar of five exact hits.
  const nested = moduleOf("ri", 2, 500);
  const small = signature(h.path, "small-h", [{ body: wrapperOf("sh", 2, 40), deps: [1], path: "small-h/index.js" }, { body: nested, path: "small-h/node_modules/nest-r/index.js" }]);
  const withEdge = buildInventory(compile(h.path, bundle([{ body: APP }, { body: nested }, { body: wrapperOf("sh", 2, 40), deps: [1] }]))).inventory;
  const report = matchBoth(withEdge, ([small]));
  assert.equal(scoreOf(report, "small-h")?.tier, "high", JSON.stringify(scoreOf(report, "small-h")));
  assert.deepEqual(scoreOf(report, "small-h")?.viaDependency, { by: "nest-r", edge: "exact" });
  // Without the edge (the module requires an app module) it stays medium.
  const noEdge = buildInventory(compile(h.path, bundle([{ body: APP }, { body: nested }, { body: wrapperOf("sh", 2, 40), deps: [0] }]))).inventory;
  const r2 = matchBoth(noEdge, ([small]));
  assert.notEqual(scoreOf(r2, "small-h")?.tier, "high", JSON.stringify(scoreOf(r2, "small-h")));
});
