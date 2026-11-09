// deps-transitive-subtract (MetaMask precision, docs/DEPS.md "Inlined
// dependency" / "Transitive dependency subtraction"): a pathless signature
// still holds its dependencies' code when `dep-subtract` could not remove it
// (only direct dependencies, only ones in the DB at a satisfying version at
// build time). `is-array-buffer` (subtractedDependencies: []) confirmed on
// call-bind / get-intrinsic / function-bind code alone. The match-time rule:
// a hash the package's declared dependency CLOSURE also holds as own code
// (any loaded version) is that dependency's, not the package's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireHermesc } from "../../support/hermesc.ts";
import { buildInventory } from "../../../src/deps/inventory.ts";
import { matchInventory } from "../../../src/deps/match.ts";
import { fingerprintModule, SIG_HASH_SCHEME } from "../../../src/deps/fingerprint.ts";
import { decodeFunction } from "../../../src/disasm/decode.ts";
import { parseHbc } from "../../../src/parse/module.ts";
import { loadSignatures, type LoadedSig } from "../../../src/deps/db.ts";
import type { SigDbFile } from "../../../src/deps/sigdb-types.ts";

const HEAD = "function __d(factory, moduleId, deps) {}";
const FN = "function (global, require, importDefault, exportAll, module, exports, dependencyMap)";
const bundle = (bodies: readonly string[]): string => [HEAD, ...bodies.map((b, id) => `__d(${FN}{${b}},${id},[]);`)].join("\n") + "\n";
const helpers = (tag: string, n: number, seed: number): string[] =>
  Array.from({ length: n }, (_, i) => `function ${tag}${i}(x, y) { var t = ${seed + i}; for (var k = 0; k < x; k++) { t = (t * ${31 + i} + k * y - (k % ${3 + i})) % ${1000003 + seed}; if (t > ${500 + i}) t = t - y; } return t + "${tag}${i}".length; }`);
const file = (fns: readonly string[]): string => fns.join("\n") + "\nmodule.exports = { " + fns.map((s) => /^function (\w+)/.exec(s)![1]!).map((n) => `${n}: ${n}`).join(", ") + " };";

function compile(hermesc: string, js: string): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-transub-"));
  try {
    execFileSync(hermesc, ["-O", "-emit-binary", `-out=${join(dir, "o.hbc")}`, "-"], { input: js });
    return new Uint8Array(readFileSync(join(dir, "o.hbc")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function signature(hermesc: string, pkg: string, bodies: readonly string[], closure?: readonly string[]): SigDbFile {
  const mod = parseHbc(compile(hermesc, bundle(bodies)));
  const fp = fingerprintModule(mod, decodeFunction);
  return {
    schema: 2, hashScheme: SIG_HASH_SCHEME, package: pkg, version: "1.0.0", hbcVersion: mod.header.version,
    totalFunctions: fp.functions.length, rawFunctionCount: fp.functions.length, subtractedBaselines: [], functions: fp.functions, modules: fp.modules.map(({ nestedFunctionIndices: _n, ...m }) => m), toolchainBaseline: false,
    provenance: { packageSha256: null, metroVersion: null, reactNativeVersion: null, hermescVersion: mod.header.version, hermescRnEra: null, repoCommit: null, builtAt: "2026-11-10T00:00:00.000Z" },
    subtractedDependencies: [],
    ...(closure === undefined ? {} : { dependencyClosure: closure }),
  };
}

const APP = `var c = 1; for (var w = 0; w < 19; w++) { c = (c * 31 + w) % 1000003; } module.exports = function appOnly(v) { return c ^ v; };`;
const OWN = file(helpers("sp", 12, 71)); // the shim package's own index.js
const MID = file(helpers("cb", 20, 2001)); // call-bind's own code
const LEAF = file(helpers("fb", 20, 5001)); // function-bind's own code
const loaded = (files: readonly SigDbFile[]): LoadedSig[] => files.map((f) => ({ file: f, layer: "shared", path: `<${f.package}>` }));
// Pathless, as every bulk file built before module paths: the shim's file
// holds call-bind's and function-bind's modules (dep-subtract found neither).
const sigs = (h: string, closure: readonly string[] | undefined): LoadedSig[] => loaded([
  signature(h, "shim-p", [OWN, MID, LEAF], closure),
  signature(h, "call-bind", [MID, LEAF], closure === undefined ? undefined : ["function-bind"]),
  signature(h, "function-bind", [LEAF]),
]);
const scoreOf = (r: ReturnType<typeof matchInventory>, p: string) => r.packages.find((s) => s.package === p);

test("deps-transitive-subtract: a package whose hits are all its dependency closure's code is not confirmed", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  const target = buildInventory(compile(h.path, bundle([APP, MID, LEAF]))).inventory;
  const r = matchInventory(target, sigs(h.path, ["call-bind", "function-bind"]));
  assert.notEqual(scoreOf(r, "shim-p")?.tier, "high", JSON.stringify(scoreOf(r, "shim-p")));
  assert.equal(scoreOf(r, "call-bind")?.tier, "high", JSON.stringify(scoreOf(r, "call-bind")));
  assert.equal(scoreOf(r, "function-bind")?.tier, "high");
});

test("deps-transitive-subtract: the package's own code present keeps it high", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  const target = buildInventory(compile(h.path, bundle([APP, OWN, MID, LEAF]))).inventory;
  const r = matchInventory(target, sigs(h.path, ["call-bind", "function-bind"]));
  assert.equal(scoreOf(r, "shim-p")?.tier, "high", JSON.stringify(scoreOf(r, "shim-p")));
  assert.equal(scoreOf(r, "call-bind")?.tier, "high");
});

test("deps-transitive-subtract: without a declared closure nothing is subtracted", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  const target = buildInventory(compile(h.path, bundle([APP, MID, LEAF]))).inventory;
  const r = matchInventory(target, sigs(h.path, undefined));
  assert.equal(scoreOf(r, "shim-p")?.tier, "high", JSON.stringify(scoreOf(r, "shim-p")));
});

test("deps-transitive-subtract: a dependency that itself depends on the package takes nothing from it", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  // Cycle (one side's metadata from another version): neither side's code
  // can be told apart by the edge, so the rule stays out.
  const target = buildInventory(compile(h.path, bundle([APP, MID, LEAF]))).inventory;
  const files = sigs(h.path, ["call-bind", "function-bind"]).map((l) => l.file.package !== "call-bind" ? l : { ...l, file: { ...l.file, dependencyClosure: ["function-bind", "shim-p"] } });
  const r = matchInventory(target, files);
  assert.equal(scoreOf(r, "shim-p")?.tier, "high", JSON.stringify(scoreOf(r, "shim-p")));
});

test("deps-transitive-subtract: loadSignatures attaches a layer's dependency-closure.json", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-transub-db-"));
  try {
    const s = signature(h.path, "shim-p", [OWN]);
    writeFileSync(join(dir, "shim-p@1.0.0__hbc96.json"), JSON.stringify(s));
    writeFileSync(join(dir, "dependency-closure.json"), JSON.stringify({ "shim-p@1.0.0": ["call-bind", "function-bind"] }));
    const [l] = loadSignatures([{ name: "shared", dir }]);
    assert.deepEqual(l?.file.dependencyClosure, ["call-bind", "function-bind"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deps-transitive-subtract: closures follow only the in-DB version satisfying each range", async () => {
  const { dependencyClosures } = await import("../../../tools/pkgsig/bulk/dep-closure.mjs");
  const versions = new Map([["call-bind", ["1.0.8"]], ["function-bind", ["1.1.2"]], ["which-typed-array", ["1.1.2", "1.1.18"]], ["is-typed-array", ["1.1.10"]]]);
  const declared = {
    "is-array-buffer@3.0.5": { "call-bind": "^1.0.8", "get-intrinsic": "^1.2.6" },
    "call-bind@1.0.8": { "function-bind": "^1.1.2" },
    "is-typed-array@1.1.10": { "which-typed-array": "^1.1.11" },
    // an old release's edge back: must not leak into 1.1.18's dependents
    "which-typed-array@1.1.2": { "is-typed-array": "^1.1.10" },
    "which-typed-array@1.1.18": { "call-bind": "^1.0.8" },
  };
  const c = dependencyClosures(declared, versions);
  assert.deepEqual(c["is-array-buffer@3.0.5"], ["call-bind", "function-bind", "get-intrinsic"]);
  assert.deepEqual(c["is-typed-array@1.1.10"], ["call-bind", "function-bind", "which-typed-array"]);
});
