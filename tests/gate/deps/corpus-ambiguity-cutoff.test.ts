// corpus-ambiguity-cutoff (docs/DEPS.md "Ambiguity counts independent
// owners"): `AMBIGUOUS_OWNER_THRESHOLD` counted claimant names among the
// LOADED candidates, so DB growth alone (more candidates loaded) pushed a
// true package's hashes over the cutoff: MetaMask lost define-properties,
// es-define-property, has-symbols and hasown when pop2 grew its candidates
// 816 -> 1,253, and bluesky lost react-native-gesture-handler. Principle:
// the count takes only independent owners. A claimant whose recorded
// dependency closure holds another claimant carries that claimant's code,
// and a candidate with no target evidence of its own is not a competing
// owner for a package the target does support.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireHermesc } from "../../support/hermesc.ts";
import { buildInventory } from "../../../src/deps/inventory.ts";
import { AMBIGUOUS_OWNER_THRESHOLD, matchInventory } from "../../../src/deps/match.ts";
import { fingerprintModule, SIG_HASH_SCHEME } from "../../../src/deps/fingerprint.ts";
import { decodeFunction } from "../../../src/disasm/decode.ts";
import { parseHbc } from "../../../src/parse/module.ts";
import type { LoadedSig } from "../../../src/deps/db.ts";
import type { SigDbFile } from "../../../src/deps/sigdb-types.ts";

const HEAD = "function __d(factory, moduleId, deps) {}";
const FN = "function (global, require, importDefault, exportAll, module, exports, dependencyMap)";
const bundle = (bodies: readonly string[]): string => [HEAD, ...bodies.map((b, id) => `__d(${FN}{${b}},${id},[]);`)].join("\n") + "\n";
const helpers = (tag: string, n: number, seed: number): string[] =>
  Array.from({ length: n }, (_, i) => `function ${tag}${i}(x, y) { var t = ${seed + i}; for (var k = 0; k < x; k++) { t = (t * ${31 + i} + k * y - (k % ${3 + i})) % ${1000003 + seed}; if (t > ${500 + i}) t = t - y; } return t + "${tag}${i}".length; }`);
const moduleOf = (tag: string, n: number, seed: number): string => helpers(tag, n, seed).join("\n") + "\nmodule.exports = { " + Array.from({ length: n }, (_, i) => `${tag}${i}: ${tag}${i}`).join(", ") + " };";

function compile(hermesc: string, js: string): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-ambig-"));
  try {
    execFileSync(hermesc, ["-O", "-emit-binary", `-out=${join(dir, "o.hbc")}`, "-"], { input: js });
    return new Uint8Array(readFileSync(join(dir, "o.hbc")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const cache = new Map<string, SigDbFile>();
function signature(hermesc: string, pkg: string, bodies: readonly string[], deps?: readonly string[]): SigDbFile {
  const key = pkg + "\0" + bodies.join("\0") + "\0" + (deps ?? []).join(",");
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const mod = parseHbc(compile(hermesc, bundle(bodies)));
  const fp = fingerprintModule(mod, decodeFunction);
  const file: SigDbFile = {
    schema: 2, hashScheme: SIG_HASH_SCHEME, package: pkg, version: "1.0.0", hbcVersion: mod.header.version,
    totalFunctions: fp.functions.length, rawFunctionCount: fp.functions.length, subtractedBaselines: [], functions: fp.functions, modules: fp.modules.map(({ nestedFunctionIndices: _n, ...m }) => m), toolchainBaseline: false,
    provenance: { packageSha256: null, metroVersion: null, reactNativeVersion: null, hermescVersion: mod.header.version, hermescRnEra: null, repoCommit: null, builtAt: "2026-11-10T00:00:00.000Z" },
    ...(deps === undefined ? {} : { subtractedDependencies: deps.map((d) => `${d}@1.0.0__hbc${mod.header.version}.json`) }),
  };
  cache.set(key, file);
  return file;
}

const loaded = (files: readonly SigDbFile[]): LoadedSig[] => files.map((file) => ({ file, layer: "shared", path: `<${file.package}>` }));
const scoreOf = (report: ReturnType<typeof matchInventory>, p: string) => report.packages.find((s) => s.package === p);
const APP = `var c = 1; for (var w = 0; w < 19; w++) { c = (c * 31 + w) % 1000003; } module.exports = function appOnly(v) { return c ^ v; };`;
const X = (): string => moduleOf("xq", 12, 11);
// `n` other packages that each hold X next to code of their own the app
// does not contain.
const carriers = (h: string, prefix: string, n: number, deps?: readonly string[]): SigDbFile[] =>
  Array.from({ length: n }, (_, i) => signature(h, `${prefix}${i}`, [moduleOf(`${prefix.replace(/-/g, "")}o${i}x`, 3, 5000 + 37 * i), X()], deps));

test("corpus-ambiguity-cutoff: dependents that carry a package's code do not push it over the cutoff", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  const target = buildInventory(compile(h.path, bundle([APP, X()]))).inventory;
  const x = signature(h.path, "x-real", [X()], []);
  // mid depends on x-real; every dependent depends on mid (x-real is
  // transitive, so J4 subtraction left its code in them).
  const mid = signature(h.path, "mid", [moduleOf("mid", 3, 7001), X()], ["x-real"]);
  const few = carriers(h.path, "dep-", AMBIGUOUS_OWNER_THRESHOLD - 3, ["mid"]);
  const before = matchInventory(target, loaded([x, mid, ...few]));
  assert.equal(scoreOf(before, "x-real")?.tier, "high", "below the cutoff: " + JSON.stringify(scoreOf(before, "x-real")));
  const many = carriers(h.path, "dep-", AMBIGUOUS_OWNER_THRESHOLD + 2, ["mid"]);
  const grown = matchInventory(target, loaded([x, mid, ...many]));
  assert.equal(scoreOf(grown, "x-real")?.tier, "high", "more dependents loaded: " + JSON.stringify(scoreOf(grown, "x-real")));
  for (const p of ["mid", "dep-0", `dep-${AMBIGUOUS_OWNER_THRESHOLD + 1}`]) assert.notEqual(scoreOf(grown, p)?.tier, "high", p + ": " + JSON.stringify(scoreOf(grown, p)));
});

test("corpus-ambiguity-cutoff: loading more candidates without target evidence of their own does not take a supported package's hits", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  // r is in the app by a module only it holds (R) and shares X with
  // unrelated candidates that have no other code in the app.
  const R = moduleOf("rq", 12, 3001);
  const target = buildInventory(compile(h.path, bundle([APP, R, X()]))).inventory;
  const r = signature(h.path, "r-real", [R, X()]);
  const before = matchInventory(target, loaded([r, ...carriers(h.path, "other-", AMBIGUOUS_OWNER_THRESHOLD - 5)]));
  const grown = matchInventory(target, loaded([r, ...carriers(h.path, "other-", AMBIGUOUS_OWNER_THRESHOLD + 5)]));
  assert.ok((scoreOf(before, "r-real")?.exactHits ?? 0) > 13, "below the cutoff X counts for r: " + JSON.stringify(scoreOf(before, "r-real")));
  assert.equal(scoreOf(grown, "r-real")?.exactHits, scoreOf(before, "r-real")?.exactHits, "grown: " + JSON.stringify(scoreOf(grown, "r-real")));
  assert.equal(scoreOf(grown, "r-real")?.moduleExactHits, scoreOf(before, "r-real")?.moduleExactHits);
  assert.equal(scoreOf(grown, "other-0")?.exactHits, 0, "an unsupported carrier gains nothing: " + JSON.stringify(scoreOf(grown, "other-0")));
});

test("corpus-ambiguity-cutoff: code shared by many independent claimants none of which the target supports stays ambiguous", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  // Boilerplate family: x-real and its siblings are independent (no
  // recorded dependency) and the app holds nothing but the shared code.
  const target = buildInventory(compile(h.path, bundle([APP, X()]))).inventory;
  const x = signature(h.path, "x-real", [X()], []);
  const r = matchInventory(target, loaded([x, ...carriers(h.path, "sib-", AMBIGUOUS_OWNER_THRESHOLD + 2, [])]));
  for (const p of ["x-real", "sib-0"]) assert.equal(scoreOf(r, p)?.exactHits, 0, p + ": " + JSON.stringify(scoreOf(r, p)));
});

// review-1110 deps rules (fix 2): "supported" needs a unique target hit
// that is real evidence, i.e. at least minInstr instructions and not
// generic in the target (TARGET_GENERIC_COPIES). A package whose only
// unique hit is a helper the app repeats three times is not supported, so
// it keeps no share of code 20+ independent claimants hold.
test("corpus-ambiguity-cutoff: a unique hit the target holds generically does not make a package supported (review-1110)", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  const G = moduleOf("gq", 1, 5001);
  const target = buildInventory(compile(h.path, bundle([APP, G, G, G, X()]))).inventory;
  const g = signature(h.path, "g-generic", [G, X()]);
  const grown = matchInventory(target, loaded([g, ...carriers(h.path, "other-", AMBIGUOUS_OWNER_THRESHOLD + 5)]));
  assert.ok((scoreOf(grown, "g-generic")?.exactHits ?? 0) < 6, "X stays ambiguous for g: " + JSON.stringify(scoreOf(grown, "g-generic")));
});

// deps-land-1110: MetaMask +pop2 confirmed ent, is-date-object and eventid
// (all false positives) on get-intrinsic-era code that 20-22 loaded
// packages hold. The hbc96 DB has no get-intrinsic or call-bound, so no
// claimant is the code's owner; removing the dependents left 9-15
// mutually independent carriers, and every one kept the code because
// fewer than 20 remained. Removing dependents only says something about a
// claimant the removed dependents depend on (their code is its code). An
// unsupported claimant nobody depends on gains nothing from it: for it the
// hash is as ambiguous as before.
test("deps-land-1110: independent carriers of an absent package's code do not share it once dependents are removed", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  const target = buildInventory(compile(h.path, bundle([APP, X()]))).inventory;
  // Five independent carriers, the first with many dependents; nobody in
  // the DB is X's real package.
  const owners = carriers(h.path, "car-", 5, []);
  const deps = carriers(h.path, "dep-", AMBIGUOUS_OWNER_THRESHOLD, ["car-0"]);
  const r = matchInventory(target, loaded([...owners, ...deps]));
  for (const p of ["car-1", "car-4"]) assert.notEqual(scoreOf(r, p)?.tier, "high", p + ": " + JSON.stringify(scoreOf(r, p)));
  assert.equal(scoreOf(r, "car-1")?.exactHits, 0, "X stays ambiguous for an independent carrier: " + JSON.stringify(scoreOf(r, "car-1")));
});

// deps-land-1110: bluesky +pop2 confirmed realm and victory-core (false
// positives) on code 20+ loaded packages hold, kept because each had one or
// two unique target hits (realm one 28-instruction function, victory-core
// 8 and 13 instructions). Every bluesky true package that needs the
// supported clause has dozens. Support is evidence of the package's own
// presence, so it needs the few-distinct bar every other confirmation
// needs: MIN_DISTINCT_EVIDENCE_HASHES distinct unique hits.
test("deps-land-1110: one or two unique hits do not make a package supported", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  const S = moduleOf("sq", 1, 3101);
  const target = buildInventory(compile(h.path, bundle([APP, S, X()]))).inventory;
  const s = signature(h.path, "s-thin", [S, X()]);
  const r = matchInventory(target, loaded([s, ...carriers(h.path, "other-", AMBIGUOUS_OWNER_THRESHOLD + 5)]));
  assert.ok((scoreOf(r, "s-thin")?.exactHits ?? 0) < 6, "X stays ambiguous for s-thin: " + JSON.stringify(scoreOf(r, "s-thin")));
});

// deps-land-1110: bluesky lost lodash.throttle on the transitive-
// subtraction farm. Its 4.0.x files depend on lodash.debounce, 4.1.1
// depends on nothing and inlines debounce's helpers. The closure rule took
// each package's closure as the union over its loaded versions, so 4.1.1's
// inlined helpers were set aside as debounce's code, leaving one own hit.
// A file's closure is its own version's.
test("deps-land-1110: a version that depends on nothing keeps the code an older version's dependency also holds", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  const DEB = moduleOf("db", 6, 6101);
  const THR = helpers("db", 6, 6101).join("\n") + "\nfunction th0(f, w) { return db0(w, 3) + db1(w, 5); }\nmodule.exports = { db0: db0, db1: db1, db2: db2, db3: db3, db4: db4, db5: db5, th0: th0 };";
  const THR_APP = THR + "\nmodule.exports.qq = 2;";
  const target = buildInventory(compile(h.path, bundle([APP, DEB, THR_APP]))).inventory;
  const deb = { ...signature(h.path, "debounce", [DEB], []), dependencyClosure: [] };
  const old = { ...signature(h.path, "throttle", [THR], ["debounce"]), version: "1.0.0", dependencyClosure: ["debounce"] };
  const cur = { ...signature(h.path, "throttle", [THR], []), version: "2.0.0", dependencyClosure: [] };
  const r = matchInventory(target, loaded([deb, old, cur]));
  const thr = r.packages.filter((s) => s.package === "throttle").sort((a, b) => b.exactHits - a.exactHits)[0];
  assert.ok((thr?.exactHits ?? 0) >= 7, "throttle@2 keeps its inlined helpers: " + JSON.stringify(r.packages.filter((s) => s.package === "throttle")));
});
