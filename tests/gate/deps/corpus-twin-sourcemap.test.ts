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
import type { LoadedSig } from "../../../src/deps/db.ts";
import type { SigDbFile } from "../../../src/deps/sigdb-types.ts";

const HEAD = "function __d(factory, moduleId, deps) {}";
const FN = "function (global, require, importDefault, exportAll, module, exports, dependencyMap)";
const bundle = (bodies: readonly string[]): string => [HEAD, ...bodies.map((b, id) => `__d(${FN}{${b}},${id},[]);`)].join("\n") + "\n";

// `n` distinct pure helper functions (no captured variables, so the same
// source hashes the same wherever it is nested), named with `tag`.
const helpers = (tag: string, n: number, seed: number): string[] =>
  Array.from({ length: n }, (_, i) => `function ${tag}${i}(x, y) { var t = ${seed + i}; for (var k = 0; k < x; k++) { t = (t * ${31 + i} + k * y - (k % ${3 + i})) % ${1000003 + seed}; if (t > ${500 + i}) t = t - y; } return t + "${tag}${i}".length; }`);
const exportAll = (names: readonly string[]): string => `module.exports = { ${names.map((n) => `${n}: ${n}`).join(", ")} };`;
const fnNames = (tag: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${tag}${i}`);
const moduleOf = (tag: string, n: number, seed: number): string => helpers(tag, n, seed).join("\n") + "\n" + exportAll(fnNames(tag, n));

function compile(hermesc: string, js: string): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-twin-sm-"));
  try {
    execFileSync(hermesc, ["-O", "-emit-binary", `-out=${join(dir, "o.hbc")}`, "-"], { input: js });
    return new Uint8Array(readFileSync(join(dir, "o.hbc")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function signature(hermesc: string, pkg: string, bodies: readonly string[], opts: { paths?: readonly string[]; deps?: readonly string[] } = {}): SigDbFile {
  const mod = parseHbc(compile(hermesc, bundle(bodies)));
  const fp = fingerprintModule(mod, decodeFunction);
  const modules = fp.modules.map(({ nestedFunctionIndices: _n, ...m }, i) => (opts.paths === undefined ? m : { ...m, path: opts.paths[i] ?? null }));
  return {
    schema: 2, hashScheme: SIG_HASH_SCHEME, package: pkg, version: "1.0.0", hbcVersion: mod.header.version,
    totalFunctions: fp.functions.length, rawFunctionCount: fp.functions.length, subtractedBaselines: [], functions: fp.functions, modules, toolchainBaseline: false,
    provenance: { packageSha256: null, metroVersion: null, reactNativeVersion: null, hermescVersion: mod.header.version, hermescRnEra: null, repoCommit: null, builtAt: "2026-11-09T00:00:00.000Z" },
    ...(opts.paths === undefined ? {} : { modulePaths: 1 }),
    ...(opts.deps === undefined ? {} : { subtractedDependencies: opts.deps }),
  };
}

const loaded = (files: readonly SigDbFile[]): LoadedSig[] => files.map((file) => ({ file, layer: "shared", path: `<${file.package}>` }));
const tierOf = (report: ReturnType<typeof matchInventory>, p: string) => report.packages.find((s) => s.package === p);

// A boilerplate factory: distinct enough to be no-one else's, repeated.
const APP = `var c = 1; for (var w = 0; w < 19; w++) { c = (c * 31 + w) % 1000003; } module.exports = function appOnly(v) { return c ^ v; };`;

// corpus-twin-sourcemap: Expensify ships source-map@0.6.1; the fork
// source-map-js (path-bearing, 40 hits) had every hit inside source-map's
// 46, but those 40 are only 87% of source-map's set, so the mutual 90%
// twin test failed, and 46 < 2 x 40 kept `embedded` off. The fork changed
// some functions, so its hits are a strict subset of the original's.
test("corpus-twin-sourcemap: a fork whose hits all sit inside a path-bearing original's larger set is that original (twin)", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  const sharedMods = [moduleOf("sm", 4, 21), moduleOf("sn", 4, 61), moduleOf("so", 4, 81)];
  const origOnly = moduleOf("sp", 4, 101); // in the original, changed in the fork
  const forkOnly = moduleOf("fk", 4, 901);
  const orig = signature(h.path, "orig-map", [...sharedMods, origOnly], { paths: [0, 1, 2, 3].map((i) => `orig-map/lib/m${i}.js`) });
  const fork = signature(h.path, "fork-map-js", [...sharedMods, forkOnly], { paths: [0, 1, 2, 3].map((i) => `fork-map-js/lib/m${i}.js`) });
  const target = buildInventory(compile(h.path, bundle([APP, ...sharedMods, origOnly]))).inventory;
  const r1 = matchInventory(target, loaded([orig, fork]));
  const o = tierOf(r1, "orig-map");
  const f = tierOf(r1, "fork-map-js");
  assert.equal(o?.tier, "high", JSON.stringify(o));
  assert.ok((f?.exactHits ?? 0) < 0.9 * (o?.exactHits ?? 0) && (o?.exactHits ?? 0) < 2 * (f?.exactHits ?? 0), `shape: fork ${f?.exactHits} vs orig ${o?.exactHits} sits between twin and embedded`);
  assert.deepEqual(f?.demotion, { rule: "twin", by: "orig-map" }, JSON.stringify(f));
  // A pathless original explains nothing: its signature may hold the
  // fork's code as a dependency, so both stay.
  const { modulePaths: _m, ...origPathless } = orig;
  const r2 = matchInventory(target, loaded([origPathless as SigDbFile, fork]));
  assert.equal(tierOf(r2, "fork-map-js")?.tier, "high", "a pathless covering package does not demote");
  // A declared dependency of another confirmed package is kept, as in the
  // mutual twin rule.
  const user = signature(h.path, "user-pkg", [moduleOf("us", 3, 700), moduleOf("ut", 3, 740), moduleOf("uu", 3, 780)], { deps: ["fork-map-js@1.0.0__hbc96.json"] });
  const target3 = buildInventory(compile(h.path, bundle([APP, ...sharedMods, origOnly, moduleOf("us", 3, 700), moduleOf("ut", 3, 740), moduleOf("uu", 3, 780)]))).inventory;
  const r3 = matchInventory(target3, loaded([orig, fork, user]));
  assert.equal(tierOf(r3, "fork-map-js")?.tier, "high", "the declared dependency is kept");
  assert.equal(tierOf(r3, "orig-map")?.tier, "high");
});
