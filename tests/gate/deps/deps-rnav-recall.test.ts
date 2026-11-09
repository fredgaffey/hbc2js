// deps-rnav-recall (docs/DEPS.md "Tiny packages on DB-unique hashes"): a
// tiny package whose module factory does not exact-match (another babel
// preset, another version's export list) is still the package when at least
// half its functions exact-match and two of them are hashes the whole DB
// gives to this package alone (the candidate hash index, maxOwners 1):
// react-freeze, stacktrace-parser, invariant, @react-native/normalize-colors
// on react-navigation-example. The same hits shared with another DB package
// (immediate, the 23-package rainbow dist family) stay below high.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireHermesc } from "../../support/hermesc.ts";
import { buildInventory } from "../../../src/deps/inventory.ts";
import { matchInventory } from "../../../src/deps/match.ts";
import { resolveDbLayers, type LoadedSig } from "../../../src/deps/db.ts";
import { uniqueHashOwnersInTarget, writeCandidateHashIndex } from "../../../src/deps/hash-index.ts";
import { fingerprintModule, SIG_HASH_SCHEME } from "../../../src/deps/fingerprint.ts";
import { decodeFunction } from "../../../src/disasm/decode.ts";
import { parseHbc } from "../../../src/parse/module.ts";
import type { SigDbFile } from "../../../src/deps/sigdb-types.ts";

const HEAD = "function __d(factory, moduleId, deps) {}";
const FN = "function (global, require, importDefault, exportAll, module, exports, dependencyMap)";
const bundle = (bodies: readonly string[]): string => [HEAD, ...bodies.map((b, id) => `__d(${FN}{${b}},${id},[]);`)].join("\n") + "\n";
// Helper `i` of a package; `alt` changes its body (another version, or app code).
const helper = (i: number, alt = 0): string => `function tp${i}(x, y) { var t = ${7 + i + 100 * alt}; for (var k = 0; k < x; k++) { t = (t * ${31 + i} + k * y - (k % ${3 + i + alt})) % 1000003; if (t > ${500 + i}) t = t - y; } return t + "tp${i}".length; }`;
// A module of `n` helpers, the first `same` as in the package; `extra`
// changes the export list, so the factory hash differs from the package's.
const tinyModule = (n: number, same: number, extra = ""): string =>
  Array.from({ length: n }, (_, i) => helper(i, i < same ? 0 : 1)).join("\n") + `\nmodule.exports = { ${Array.from({ length: n }, (_, i) => `tp${i}: tp${i}`).join(", ")}${extra} };`;
const APP = `var c = 1; for (var w = 0; w < 19; w++) { c = (c * 31 + w) % 1000003; } module.exports = function appOnly(v) { return c ^ v; };`;

function compile(hermesc: string, js: string): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-rnav-recall-"));
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

/** Writes `files` as a signature DB with its candidate hash index, scores
 *  the app built from `target`, and returns `pkg`'s score. */
function scoreWithIndex(hermesc: string, files: readonly SigDbFile[], pkg: string, target: string) {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-rnav-recall-db-"));
  try {
    for (const f of files) writeFileSync(join(dir, `${f.package}@${f.version}__hbc${f.hbcVersion}.json`), JSON.stringify(f));
    writeCandidateHashIndex(dir, dir, files[0]!.hbcVersion);
    const inv = buildInventory(compile(hermesc, bundle([APP, target]))).inventory;
    const uniqueHashOwners = uniqueHashOwnersInTarget(resolveDbLayers({ sigdb: dir, noSharedDb: true }), inv);
    const sigs: LoadedSig[] = files.map((file) => ({ file, layer: "shared", path: `<${file.package}>` }));
    return { s: matchInventory(inv, sigs, { uniqueHashOwners }).packages.find((x) => x.package === pkg), plain: matchInventory(inv, sigs).packages.find((x) => x.package === pkg), uniqueHashOwners };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("deps-rnav-recall: a tiny package without its factory but with half its functions on DB-unique hashes is high", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  // 4 helpers (6 functions with the factory and the bundle global); the
  // app's copy keeps 3 identical, alters 1 and the export list: no module
  // hit, exact coverage 3/6, every hit unique in the DB.
  const pkg = signature(h.path, "tiny-lib", [tinyModule(4, 4)]);
  const { s, plain, uniqueHashOwners } = scoreWithIndex(h.path, [pkg], "tiny-lib", tinyModule(4, 3, ", extra: 1"));
  assert.ok(s !== undefined && plain !== undefined, "scored");
  assert.ok(s.moduleExactHits === 0 && s.moduleTotal === 1 && s.exactCoverage >= 0.5, JSON.stringify(s));
  assert.ok([...uniqueHashOwners.values()].filter((p) => p === "tiny-lib").length >= 2, "index gives the helpers to tiny-lib");
  assert.notEqual(plain.tier, "high", "without the index the bar holds");
  assert.equal(s.tier, "high", JSON.stringify(s));
  assert.equal(s.demotion, undefined, JSON.stringify(s));
});

test("deps-rnav-recall: the same hits shared with another DB package stay below high", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  // A second package holds the same helpers: the index (maxOwners 1) names
  // neither, as for immediate or rainbow's 23-package dist family.
  const pkg = signature(h.path, "tiny-lib", [tinyModule(4, 4)]);
  const twin = signature(h.path, "other-lib", [tinyModule(4, 4, ", other: 2")]);
  const { s } = scoreWithIndex(h.path, [pkg, twin], "tiny-lib", tinyModule(4, 3, ", extra: 1"));
  assert.ok(s !== undefined && s.moduleExactHits === 0, JSON.stringify(s));
  assert.notEqual(s.tier, "high", JSON.stringify(s));
});

test("deps-rnav-recall: one DB-unique hit is not enough", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  // Coverage 3/6 as above, but another package holds two of the three
  // helpers, so only one hit is a hash the DB gives to tiny-lib alone.
  const pkg = signature(h.path, "tiny-lib", [tinyModule(4, 4)]);
  const twin = signature(h.path, "other-lib", [tinyModule(2, 2)]);
  const { s, uniqueHashOwners } = scoreWithIndex(h.path, [pkg, twin], "tiny-lib", tinyModule(4, 3, ", extra: 1"));
  assert.equal([...uniqueHashOwners.values()].filter((p) => p === "tiny-lib").length, 1, "one DB-unique hit");
  assert.ok(s !== undefined && s.exactCoverage >= 0.5, JSON.stringify(s));
  assert.ok(s !== undefined && s.moduleExactHits === 0, JSON.stringify(s));
  assert.notEqual(s.tier, "high", JSON.stringify(s));
});
