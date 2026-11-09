// review-1110 deps: adversarial review of the demotion / promotion rules in
// src/deps/match.ts (docs/DEPS.md "Rule review 2026-11-10"). Each test is a
// synthetic hermesc fixture for one finding.
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
import { attachModulePaths } from "../../../src/deps/module-paths.ts";
import { resolveDbLayers, type LoadedSig } from "../../../src/deps/db.ts";
import { uniqueHashOwnersInTarget, writeCandidateHashIndex } from "../../../src/deps/hash-index.ts";
import type { SigDbFile } from "../../../src/deps/sigdb-types.ts";

const HEAD = "function __d(factory, moduleId, deps) {}";
const FN = "function (global, require, importDefault, exportAll, module, exports, dependencyMap)";
interface Mod { readonly body: string; readonly deps?: readonly number[]; readonly path?: string | null }
const bundle = (mods: readonly Mod[]): string => [HEAD, ...mods.map((m, id) => `__d(${FN}{${m.body}},${id},[${(m.deps ?? []).join(",")}]);`)].join("\n") + "\n";
const helpers = (tag: string, n: number, seed: number): string[] =>
  Array.from({ length: n }, (_, i) => `function ${tag}${i}(x, y) { var t = ${seed + i}; for (var k = 0; k < x; k++) { t = (t * ${31 + i} + k * y - (k % ${3 + i})) % ${1000003 + seed}; if (t > ${500 + i}) t = t - y; } return t + "${tag}${i}".length; }`);
const fnNames = (tag: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${tag}${i}`);
const exportAll = (names: readonly string[]): string => `module.exports = { ${names.map((n) => `${n}: ${n}`).join(", ")} };`;
const moduleOf = (tag: string, n: number, seed: number): string => helpers(tag, n, seed).join("\n") + "\n" + exportAll(fnNames(tag, n));
const wrapperOf = (tag: string, n: number, seed: number): string =>
  `var dep = require(dependencyMap[0]);\n` +
  Array.from({ length: n }, (_, i) => `function ${tag}${i}(x) { var r = dep.d0(x, ${seed + i}); for (var j = 0; j < ${3 + i}; j++) { ${"r = r + dep.d1(j, x) * 7; ".repeat(i + 1)}} return r + "${tag}${i}".length; }`).join("\n") +
  "\n" + exportAll(fnNames(tag, n));
const APP = `var c = 1; for (var w = 0; w < 19; w++) { c = (c * 31 + w) % 1000003; } module.exports = function appOnly(v) { return c ^ v; };`;

function compile(hermesc: string, js: string): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-review-1110-"));
  try {
    execFileSync(hermesc, ["-O", "-emit-binary", `-out=${join(dir, "o.hbc")}`, "-"], { input: js });
    return new Uint8Array(readFileSync(join(dir, "o.hbc")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function signature(hermesc: string, pkg: string, mods: readonly Mod[], deps?: readonly string[]): SigDbFile {
  const mod = parseHbc(compile(hermesc, bundle(mods)));
  const fp = fingerprintModule(mod, decodeFunction);
  const pathBearing = mods.some((m) => m.path !== undefined);
  const attached = pathBearing ? attachModulePaths(mod, decodeFunction, fp.functions, fp.modules, new Map(mods.map((m, id) => [id, m.path ?? null]))) : fp;
  return {
    schema: 2, hashScheme: SIG_HASH_SCHEME, package: pkg, version: "1.0.0", hbcVersion: mod.header.version,
    totalFunctions: fp.functions.length, rawFunctionCount: fp.functions.length, subtractedBaselines: [], functions: attached.functions,
    modules: attached.modules.map(({ nestedFunctionIndices: _n, ...m }) => m), toolchainBaseline: false,
    provenance: { packageSha256: null, metroVersion: null, reactNativeVersion: null, hermescVersion: mod.header.version, hermescRnEra: null, repoCommit: null, builtAt: "2026-11-10T00:00:00.000Z" },
    ...(pathBearing ? { modulePaths: 1 } : {}),
    ...(deps === undefined ? {} : { subtractedDependencies: deps }),
  };
}
const loaded = (files: readonly SigDbFile[]): LoadedSig[] => files.map((file) => ({ file, layer: "shared", path: `<${file.package}>` }));
const scoreOf = (report: ReturnType<typeof matchInventory>, p: string) => report.packages.find((s) => s.package === p);
const target = (hermesc: string, mods: readonly Mod[]) => buildInventory(compile(hermesc, bundle([{ body: APP }, ...mods]))).inventory;

test("review-1110 deps: twin keeps a scoped declared dependency (subtractedDependencies are file names, @s__p@v__hbcN.json)", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  // corpus-twin-sourcemap's r3 case under scoped names: the fork is a
  // declared dependency of a confirmed package, so it is the one kept.
  const shared = [moduleOf("sm", 4, 21), moduleOf("sn", 4, 61), moduleOf("so", 4, 81)];
  const origOnly = moduleOf("sp", 4, 101);
  const user = [moduleOf("us", 3, 700), moduleOf("ut", 3, 740), moduleOf("uu", 3, 780)];
  const orig = signature(h.path, "@s/orig-map", [...shared, origOnly].map((body, i) => ({ body, path: `@s/orig-map/lib/m${i}.js` })));
  const fork = signature(h.path, "@s/fork-map-js", [...shared, moduleOf("fk", 4, 901)].map((body, i) => ({ body, path: `@s/fork-map-js/lib/m${i}.js` })));
  const usr = signature(h.path, "user-pkg", user.map((body) => ({ body })), ["@s__fork-map-js@1.0.0__hbc96.json"]);
  const r = matchInventory(target(h.path, [...shared, origOnly, ...user].map((body) => ({ body }))), loaded([orig, fork, usr]));
  assert.equal(scoreOf(r, "user-pkg")?.tier, "high");
  assert.equal(scoreOf(r, "@s/fork-map-js")?.tier, "high", `the scoped declared dependency is kept: ${JSON.stringify(scoreOf(r, "@s/fork-map-js"))}`);
});

test("review-1110 deps: a DB-unique hit another loaded candidate also holds is not unique (unindexed layer)", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  // deps-rnav-recall's tiny-lib, and other-lib holding the same helpers in
  // a layer without a candidate hash index: the index says tiny-lib alone,
  // the loaded candidates say otherwise.
  const helper = (i: number, alt = 0): string => `function tp${i}(x, y) { var t = ${7 + i + 100 * alt}; for (var k = 0; k < x; k++) { t = (t * ${31 + i} + k * y - (k % ${3 + i + alt})) % 1000003; if (t > ${500 + i}) t = t - y; } return t + "tp${i}".length; }`;
  const tinyModule = (n: number, same: number, extra = ""): string =>
    Array.from({ length: n }, (_, i) => helper(i, i < same ? 0 : 1)).join("\n") + `\nmodule.exports = { ${Array.from({ length: n }, (_, i) => `tp${i}: tp${i}`).join(", ")}${extra} };`;
  const pkg = signature(h.path, "tiny-lib", [{ body: tinyModule(4, 4) }]);
  const other = signature(h.path, "other-lib", [{ body: tinyModule(4, 4, ", other: 2") }]);
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-review-1110-db-"));
  try {
    writeFileSync(join(dir, `tiny-lib@1.0.0__hbc${pkg.hbcVersion}.json`), JSON.stringify(pkg));
    writeCandidateHashIndex(dir, dir, pkg.hbcVersion);
    const inv = target(h.path, [{ body: tinyModule(4, 3, ", extra: 1") }]);
    const uniqueHashOwners = uniqueHashOwnersInTarget(resolveDbLayers({ sigdb: dir, noSharedDb: true }), inv);
    const alone = scoreOf(matchInventory(inv, loaded([pkg]), { uniqueHashOwners }), "tiny-lib");
    assert.equal(alone?.tier, "high", `fixture: the DB-unique path fires on its own: ${JSON.stringify(alone)}`);
    const s = scoreOf(matchInventory(inv, loaded([pkg, other]), { uniqueHashOwners }), "tiny-lib");
    assert.notEqual(s?.tier, "high", JSON.stringify(s));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review-1110 deps: embedded does not depend on DB order (a host demoted earlier in the same rule still explains)", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  // A (2 files) sits inside B's own files; B sits (>= 90%) inside C's own
  // files; C holds only one of A's two files. A's verdict must not depend
  // on whether B was judged (and demoted by C) before A.
  const a = [moduleOf("a", 5, 10), moduleOf("aa", 5, 30)];
  const b = Array.from({ length: 10 }, (_, i) => moduleOf(`b${i}x`, 5, 100 + 20 * i));
  const c = Array.from({ length: 14 }, (_, i) => moduleOf(`c${i}x`, 5, 500 + 20 * i));
  const A = signature(h.path, "pkg-a", a.map((body) => ({ body })));
  const B = signature(h.path, "pkg-b", [...a, ...b].map((body, i) => ({ body, path: `pkg-b/lib/m${i}.js` })));
  const C = signature(h.path, "pkg-c", [a[0]!, ...b, ...c].map((body, i) => ({ body, path: `pkg-c/lib/m${i}.js` })));
  const inv = target(h.path, [...a, ...b, ...c].map((body) => ({ body })));
  const first = scoreOf(matchInventory(inv, loaded([A, B, C])), "pkg-a");
  const later = scoreOf(matchInventory(inv, loaded([B, A, C])), "pkg-a");
  assert.equal(scoreOf(matchInventory(inv, loaded([A, B, C])), "pkg-b")?.demotion?.rule, "embedded", "fixture: B is C's copy");
  assert.deepEqual(first?.demotion, { rule: "embedded", by: "pkg-b" }, JSON.stringify(first));
  assert.deepEqual(later?.demotion, first?.demotion, `order-dependent: ${JSON.stringify(later)}`);
  assert.equal(later?.tier, first?.tier);
});

test("review-1110 deps: promoteViaDependency does not credit an app module another confirmed package owns by exact hash", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  // corpus-path-recall's fuzzy edge, but the wrapper-shaped app module is
  // wrap-q's own file, exact: it is evidence for wrap-q, not for wrap-p.
  const DEP = moduleOf("d", 6, 900);
  const dep = signature(h.path, "dep-d", [{ body: DEP, path: "dep-d/index.js" }]);
  const wrapP = signature(h.path, "wrap-p", [{ body: wrapperOf("wp", 4, 10), deps: [1], path: "wrap-p/index.js" }, { body: DEP, path: "dep-d/index.js" }]);
  const wrapQ = signature(h.path, "wrap-q", [{ body: wrapperOf("wq", 4, 10), deps: [1], path: "wrap-q/index.js" }, { body: DEP, path: "dep-d/index.js" }]);
  const inv = target(h.path, [{ body: DEP }, { body: wrapperOf("wq", 4, 10), deps: [1] }]);
  const r = matchInventory(inv, loaded([dep, wrapP, wrapQ]));
  assert.equal(scoreOf(r, "dep-d")?.tier, "high");
  assert.equal(scoreOf(r, "wrap-q")?.tier, "high", JSON.stringify(scoreOf(r, "wrap-q")));
  assert.equal(scoreOf(matchInventory(inv, loaded([dep, wrapP])), "wrap-p")?.tier, "high", "fixture: without wrap-q the edge confirms wrap-p");
  assert.notEqual(scoreOf(r, "wrap-p")?.tier, "high", `promoted on wrap-q's module: ${JSON.stringify(scoreOf(r, "wrap-p"))}`);
});
