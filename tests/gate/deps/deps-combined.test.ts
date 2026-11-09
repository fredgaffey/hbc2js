// deps-combined (review-deps-rules + deps-transitive-subtract merged,
// docs/DEPS.md "Combined rule hardening (deps-combined-1110)"): one
// synthetic hermesc fixture per finding left after the merge.
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
import type { SigDbFile } from "../../../src/deps/sigdb-types.ts";

import type { LoadedSig } from "../../../src/deps/db.ts";
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

const APP2 = `module.exports = function appTwo(v) { var s = 0; for (var i = 0; i < v; i++) s += i * 7; return s; };`;

// 1. inlined: scoped dependency names and a host demoted earlier in the rule.
test("deps-combined: inlined reads a scoped declared dependency (@s__p@v__hbcN.json)", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  const host = helpers("hp", 30, 81);
  const dep = helpers("ib", 25, 4001);
  const file = (fns: readonly string[]): string => fns.join("\n") + "\n" + exportAll(fns.map((s) => /^function (\w+)/.exec(s)![1]!));
  const H = signature(h.path, "host-parser", [{ body: file(host), path: "host-parser/lib/parser.js" }], ["@s__inl-builder@1.0.0__hbc96.json"]);
  const D = signature(h.path, "@s/inl-builder", [{ body: file(dep), path: "@s/inl-builder/lib/builder.js" }]);
  const r = matchInventory(target(h.path, [{ body: file([...host, ...dep]) }]), loaded([H, D]));
  assert.equal(scoreOf(r, "host-parser")?.tier, "high");
  assert.deepEqual(scoreOf(r, "@s/inl-builder")?.demotion, { rule: "inlined", by: "host-parser" }, JSON.stringify(scoreOf(r, "@s/inl-builder")));
});

test("deps-combined: inlined does not depend on DB order (a host inlined earlier in the rule still explains)", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  // R declares Q, Q declares P; all three sit in R's one dist file.
  const r0 = helpers("rr", 30, 81);
  const q0 = helpers("qq", 25, 2001);
  const p0 = helpers("pp", 25, 4001);
  const file = (fns: readonly string[]): string => fns.join("\n") + "\n" + exportAll(fns.map((s) => /^function (\w+)/.exec(s)![1]!));
  const R = signature(h.path, "pkg-r", [{ body: file(r0), path: "pkg-r/dist/r.js" }], ["pkg-q@1.0.0__hbc96.json"]);
  const Q = signature(h.path, "pkg-q", [{ body: file(q0), path: "pkg-q/lib/q.js" }], ["pkg-p@1.0.0__hbc96.json"]);
  const P = signature(h.path, "pkg-p", [{ body: file(p0), path: "pkg-p/lib/p.js" }]);
  const inv = target(h.path, [{ body: file([...r0, ...q0, ...p0]) }]);
  const late = scoreOf(matchInventory(inv, loaded([R, Q, P])), "pkg-p");
  const early = scoreOf(matchInventory(inv, loaded([P, R, Q])), "pkg-p");
  assert.deepEqual(scoreOf(matchInventory(inv, loaded([R, Q, P])), "pkg-q")?.demotion, { rule: "inlined", by: "pkg-r" }, "fixture: Q is inlined in R");
  assert.deepEqual(early?.demotion, { rule: "inlined", by: "pkg-q" }, JSON.stringify(early));
  assert.deepEqual(late?.demotion, early?.demotion, `order-dependent: ${JSON.stringify(late)}`);
});

// 2. transitive subtraction: own evidence outside the closure must be real.
const OWN = helpers("sp", 12, 71);
const MID = moduleOf("cb", 20, 2001);
const LEAF = moduleOf("fb", 20, 5001);
const shimSigs = (h: string): LoadedSig[] => loaded([
  { ...signature(h, "shim-p", [{ body: OWN.join("\n") + "\n" + exportAll(fnNames("sp", 12)) }, { body: MID }, { body: LEAF }], []), dependencyClosure: ["call-bind", "function-bind"] },
  { ...signature(h, "call-bind", [{ body: MID }, { body: LEAF }], []), dependencyClosure: ["function-bind"] },
  signature(h, "function-bind", [{ body: LEAF }], []),
]);

test("deps-combined: one own hash outside the closure does not keep the closure's code", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  const inv = target(h.path, [{ body: APP2 }, { body: OWN[0]! + "\n" + exportAll(["sp0"]) }, { body: MID }, { body: LEAF }]);
  const r = matchInventory(inv, shimSigs(h.path));
  assert.equal(scoreOf(r, "call-bind")?.tier, "high");
  assert.notEqual(scoreOf(r, "shim-p")?.tier, "high", JSON.stringify(scoreOf(r, "shim-p")));
});

test("deps-combined: own hashes generic in the target do not keep the closure's code", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  const gen = OWN.slice(0, 4).join("\n") + "\n" + exportAll(fnNames("sp", 4));
  const inv = target(h.path, [{ body: APP2 }, { body: gen }, { body: gen + "\nvar g2 = 2;" }, { body: gen + "\nvar g3 = 3;" }, { body: MID }, { body: LEAF }]);
  const r = matchInventory(inv, shimSigs(h.path));
  assert.equal(scoreOf(r, "call-bind")?.tier, "high");
  assert.notEqual(scoreOf(r, "shim-p")?.tier, "high", JSON.stringify(scoreOf(r, "shim-p")));
});

// 3. twin chain: A ~ B ~ C mutual twins, A not a twin of C.
test("deps-combined: twin does not depend on DB order (A ~ B ~ C, A not ~ C)", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  const mods = Array.from({ length: 17 }, (_, i) => moduleOf(`m${i}x`, 5, 100 + 20 * i));
  const sig = (name: string, from: number): SigDbFile => signature(h.path, name, mods.slice(from, from + 15).map((body, i) => ({ body, path: `${name}/lib/m${i}.js` })));
  const C = sig("tw-a", 2); // best by name
  const B = sig("tw-b", 1);
  const A = sig("tw-c", 0);
  const inv = target(h.path, mods.map((body) => ({ body })));
  const fwd = matchInventory(inv, loaded([A, B, C]));
  const rev = matchInventory(inv, loaded([C, B, A]));
  assert.deepEqual(scoreOf(fwd, "tw-b")?.demotion, { rule: "twin", by: "tw-a" }, "fixture: B is C's twin");
  assert.deepEqual(scoreOf(fwd, "tw-c")?.demotion, { rule: "twin", by: "tw-b" }, JSON.stringify(scoreOf(fwd, "tw-c")));
  assert.deepEqual(scoreOf(rev, "tw-c")?.demotion, scoreOf(fwd, "tw-c")?.demotion, `order-dependent: ${JSON.stringify(scoreOf(rev, "tw-c"))}`);
});

// 4. edge promotion: two forks promoted on the same app module are twins.
test("deps-combined: packages promoted by the edge rule still meet the twin rule", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  const DEP = moduleOf("d", 6, 900);
  const X = moduleOf("xo", 3, 300);
  const dep = signature(h.path, "dep-d", [{ body: DEP, path: "dep-d/index.js" }]);
  const fork = (name: string): SigDbFile => signature(h.path, name, [{ body: wrapperOf("wp", 4, 10), deps: [1], path: `${name}/index.js` }, { body: DEP, path: "dep-d/index.js" }, { body: X, path: `${name}/x.js` }]);
  const inv = target(h.path, [{ body: DEP }, { body: wrapperOf("wq", 4, 10), deps: [1] }, { body: X }]);
  const solo = scoreOf(matchInventory(inv, loaded([dep, fork("wrap-p")])), "wrap-p");
  assert.equal(solo?.tier, "high", `fixture: the edge confirms one fork: ${JSON.stringify(solo)}`);
  assert.ok(solo?.viaDependency !== undefined, "fixture: by the edge rule");
  const r = matchInventory(inv, loaded([dep, fork("wrap-p"), fork("wrap-p2")]));
  const tiers = ["wrap-p", "wrap-p2"].map((p) => scoreOf(r, p)?.tier);
  assert.deepEqual(scoreOf(r, "wrap-p2")?.demotion, { rule: "twin", by: "wrap-p" }, JSON.stringify(tiers));
});
