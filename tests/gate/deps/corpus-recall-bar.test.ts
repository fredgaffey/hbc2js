// corpus-recall-bar (docs/DEPS.md "Bar losses: tiny packages"): a tiny
// package (under 3 hashed modules) whose own module factory exact-matches
// and at least half of whose functions exact-match is the package, even
// when it has fewer than 5 functions in all (base64-js, object-assign,
// memoize-one, stacktrace-parser on Expensify and react-navigation). One
// coincidental factory with a few small helpers (abbrev, wrappy, meros:
// a quarter or less of the package) stays medium.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireHermesc } from "../../support/hermesc.ts";
import { buildInventory } from "../../../src/deps/inventory.ts";
import { matchInventory, TINY_PACKAGE_MIN_EXACT_COVERAGE } from "../../../src/deps/match.ts";
import { fingerprintModule, SIG_HASH_SCHEME } from "../../../src/deps/fingerprint.ts";
import { decodeFunction } from "../../../src/disasm/decode.ts";
import { parseHbc } from "../../../src/parse/module.ts";
import type { LoadedSig } from "../../../src/deps/db.ts";
import type { SigDbFile } from "../../../src/deps/sigdb-types.ts";

const HEAD = "function __d(factory, moduleId, deps) {}";
const FN = "function (global, require, importDefault, exportAll, module, exports, dependencyMap)";
const bundle = (bodies: readonly string[]): string => [HEAD, ...bodies.map((b, id) => `__d(${FN}{${b}},${id},[]);`)].join("\n") + "\n";
// Helper `i` of a package; `alt` changes its body (another version, or app code).
const helper = (i: number, alt = 0): string => `function tp${i}(x, y) { var t = ${7 + i + 100 * alt}; for (var k = 0; k < x; k++) { t = (t * ${31 + i} + k * y - (k % ${3 + i + alt})) % 1000003; if (t > ${500 + i}) t = t - y; } return t + "tp${i}".length; }`;
// One module: `n` helpers, the first `same` as in the package, the rest altered.
const tinyModule = (n: number, same: number): string =>
  Array.from({ length: n }, (_, i) => helper(i, i < same ? 0 : 1)).join("\n") + `\nmodule.exports = { ${Array.from({ length: n }, (_, i) => `tp${i}: tp${i}`).join(", ")} };`;
const APP = `var c = 1; for (var w = 0; w < 19; w++) { c = (c * 31 + w) % 1000003; } module.exports = function appOnly(v) { return c ^ v; };`;

function compile(hermesc: string, js: string): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-recall-bar-"));
  try {
    execFileSync(hermesc, ["-O", "-emit-binary", `-out=${join(dir, "o.hbc")}`, "-"], { input: js });
    return new Uint8Array(readFileSync(join(dir, "o.hbc")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function signature(hermesc: string, pkg: string, bodies: readonly string[]): SigDbFile {
  const mod = parseHbc(compile(hermesc, bundle(bodies)));
  const fp = fingerprintModule(mod, decodeFunction);
  return {
    schema: 2, hashScheme: SIG_HASH_SCHEME, package: pkg, version: "1.0.0", hbcVersion: mod.header.version,
    totalFunctions: fp.functions.length, rawFunctionCount: fp.functions.length, subtractedBaselines: [], functions: fp.functions,
    modules: fp.modules.map(({ nestedFunctionIndices: _n, ...m }) => m), toolchainBaseline: false,
    provenance: { packageSha256: null, metroVersion: null, reactNativeVersion: null, hermescVersion: mod.header.version, hermescRnEra: null, repoCommit: null, builtAt: "2026-11-09T00:00:00.000Z" },
  };
}
const loaded = (files: readonly SigDbFile[]): LoadedSig[] => files.map((file) => ({ file, layer: "shared", path: `<${file.package}>` }));
const scoreOf = (hermesc: string, pkg: SigDbFile, target: string) =>
  matchInventory(buildInventory(compile(hermesc, bundle([APP, target]))).inventory, loaded([pkg])).packages.find((s) => s.package === pkg.package);

test("corpus-recall-bar: a tiny package with its factory and over half its functions matched is high", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  // One module of 5 helpers (7 functions with the factory and the bundle
  // global); the app's copy has the factory and 3 helpers identical, 2
  // helpers altered: 4 exact hits, under the 5-function tiny floor, coverage 4/7.
  const pkg = signature(h.path, "tiny-lib", [tinyModule(5, 5)]);
  const s = scoreOf(h.path, pkg, tinyModule(5, 3));
  assert.ok(s !== undefined && s.moduleExactHits === 1 && s.moduleTotal === 1, JSON.stringify(s));
  assert.ok(s.exactHits < 5 && s.exactCoverage >= TINY_PACKAGE_MIN_EXACT_COVERAGE && s.exactCoverage < 0.9, JSON.stringify(s));
  assert.equal(s.tier, "high", JSON.stringify(s));
});

test("corpus-recall-bar: a tiny package with its factory but a quarter of its functions stays medium", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  // 7 helpers (8 functions); the app's copy keeps only the factory and 1
  // helper: 2/8, like abbrev/wrappy (1/4) and meros (5/24) on Expensify.
  const pkg = signature(h.path, "tiny-lib", [tinyModule(7, 7)]);
  const s = scoreOf(h.path, pkg, tinyModule(7, 1));
  assert.ok(s !== undefined && s.moduleExactHits === 1 && s.exactCoverage < TINY_PACKAGE_MIN_EXACT_COVERAGE, JSON.stringify(s));
  assert.equal(s.tier, "medium", JSON.stringify(s));
});

test("corpus-recall-bar: half the functions without the module factory stays below high", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  // immediate on Expensify: 7 of 9 functions, but no module factory
  // matches (here 4 helpers of 7 functions, the factory altered).
  const pkg = signature(h.path, "tiny-lib", [tinyModule(5, 5) + "\nmodule.exports.pad = \"one-version\";"]);
  const s = scoreOf(h.path, pkg, tinyModule(5, 4) + "\nmodule.exports.pad = \"another\";");
  assert.ok(s !== undefined && s.moduleExactHits === 0 && s.exactCoverage >= TINY_PACKAGE_MIN_EXACT_COVERAGE, JSON.stringify(s));
  assert.notEqual(s.tier, "high", JSON.stringify(s));
});
