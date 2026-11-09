// corpus-db-growth (docs/DEPS.md "DB growth must not cost true positives"):
// adding the population-retry overlay (1,251 path-bearing files) to the DB
// lost true packages and added false ones. One mechanism: a path-bearing
// signature whose OWN file is a pre-built dist that inlines other packages
// (@vitest/pretty-format's dist holds react-is and pretty-format, esquery's
// min.js holds estraverse) claims that inlined code as its own. It then
// "embedded"-demotes the real package (react-is on Expensify) and itself
// confirms on the copy (demoted as "twin" in this fixture, "embedded" on
// the real app). Another path-bearing file in the DB that holds the
// same code under the real package's path (a foreign `react-is/...` module)
// says whose code it is. Principle: a hash the DB's module paths attribute
// to other packages is not a claimant's own evidence and adds no owner.
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
const bundle = (bodies: readonly string[]): string => [HEAD, ...bodies.map((b, id) => `__d(${FN}{${b}},${id},[]);`)].join("\n") + "\n";

// `n` distinct pure helper functions (no captured variables, so the same
// source hashes the same wherever it is nested), named with `tag`.
const helpers = (tag: string, n: number, seed: number): string[] =>
  Array.from({ length: n }, (_, i) => `function ${tag}${i}(x, y) { var t = ${seed + i}; for (var k = 0; k < x; k++) { t = (t * ${31 + i} + k * y - (k % ${3 + i})) % ${1000003 + seed}; if (t > ${500 + i}) t = t - y; } return t + "${tag}${i}".length; }`);
const exportAll = (names: readonly string[]): string => `module.exports = { ${names.map((n) => `${n}: ${n}`).join(", ")} };`;
const fnNames = (tag: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${tag}${i}`);
const moduleOf = (tag: string, n: number, seed: number): string => helpers(tag, n, seed).join("\n") + "\n" + exportAll(fnNames(tag, n));

function compile(hermesc: string, js: string): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-db-growth-"));
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
  const bare = fp.modules.map(({ nestedFunctionIndices: _n, ...m }) => m);
  // Path-bearing: functions carry the moduleId of the file that creates
  // them, as the bulk builder records (one own file = one moduleId).
  const withPaths = opts.paths === undefined ? null : attachModulePaths(mod, decodeFunction, fp.functions, bare, new Map(bare.map((m, i) => [m.localModuleId!, opts.paths![i] ?? null])));
  const modules = withPaths?.modules ?? bare;
  const functions = withPaths?.functions ?? fp.functions;
  return {
    schema: 2, hashScheme: SIG_HASH_SCHEME, package: pkg, version: "1.0.0", hbcVersion: mod.header.version,
    totalFunctions: fp.functions.length, rawFunctionCount: fp.functions.length, subtractedBaselines: [], functions, modules, toolchainBaseline: false,
    provenance: { packageSha256: null, metroVersion: null, reactNativeVersion: null, hermescVersion: mod.header.version, hermescRnEra: null, repoCommit: null, builtAt: "2026-11-09T00:00:00.000Z" },
    ...(opts.paths === undefined ? {} : { modulePaths: 1 }),
    ...(opts.deps === undefined ? {} : { subtractedDependencies: opts.deps }),
  };
}

const loaded = (files: readonly SigDbFile[]): LoadedSig[] => files.map((file) => ({ file, layer: "shared", path: `<${file.package}>` }));
const tierOf = (report: ReturnType<typeof matchInventory>, p: string) => report.packages.find((s) => s.package === p);
const APP = `var c = 1; for (var w = 0; w < 19; w++) { c = (c * 31 + w) % 1000003; } module.exports = function appOnly(v) { return c ^ v; };`;



// Two real packages (x, y: pathless, as in db-v3-clean), each one module
// in the app. `dist-carrier` is a path-bearing file whose single own dist
// module inlines both plus 3 functions of its own the app does not hold.
// `wrapper` is a path-bearing file that bundled x and y as foreign
// node_modules files (the paths name them).
function fixture(h: string) {
  const X = moduleOf("xq", 12, 11);
  const Y = moduleOf("yq", 12, 211);
  const x = signature(h, "x-real", [X]);
  const y = signature(h, "y-real", [Y]);
  const dist = [...helpers("xq", 12, 11), ...helpers("yq", 12, 211), ...helpers("dc", 3, 7001)].join("\n") + "\n" + exportAll([...fnNames("xq", 12), ...fnNames("yq", 12), ...fnNames("dc", 3)]);
  const carrier = signature(h, "dist-carrier", [dist], { paths: ["dist-carrier/dist/index.js"] });
  const wrapper = signature(h, "wrapper", [moduleOf("wr", 6, 9001), X, Y], { paths: ["wrapper/index.js", "x-real/index.js", "y-real/index.js"] });
  const target = buildInventory(compile(h, bundle([APP, X, Y]))).inventory;
  return { x, y, carrier, wrapper, target };
}

test("corpus-db-growth: a dist file inlining packages the DB's paths attribute elsewhere neither demotes them nor confirms on the copy", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  const { x, y, carrier, wrapper, target } = fixture(h.path);
  const before = matchInventory(target, loaded([x, y, wrapper]));
  assert.equal(tierOf(before, "x-real")?.tier, "high", "without the carrier: " + JSON.stringify(tierOf(before, "x-real")));
  const grown = matchInventory(target, loaded([x, y, wrapper, carrier]));
  for (const p of ["x-real", "y-real"]) {
    assert.equal(tierOf(grown, p)?.tier, "high", `${p} after the DB grew: ` + JSON.stringify(tierOf(grown, p)));
    assert.equal(tierOf(grown, p)?.demotion, undefined);
  }
  assert.notEqual(tierOf(grown, "dist-carrier")?.tier, "high", "carrier: " + JSON.stringify(tierOf(grown, "dist-carrier")));
  assert.equal(tierOf(grown, "dist-carrier")?.exactHits, 0);
  const slim = matchInventory(target, loaded([x, y, wrapper, carrier].map((f) => slimSigFile(f, new Map(), slimTargetFor(target)))));
  assert.equal(tierOf(slim, "x-real")?.tier, "high", "slim: " + JSON.stringify(tierOf(slim, "x-real")));
  assert.notEqual(tierOf(slim, "dist-carrier")?.tier, "high", "slim carrier: " + JSON.stringify(tierOf(slim, "dist-carrier")));
});

test("corpus-db-growth: without path evidence for the inlined code nothing changes", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  // No file names x/y by path: the carrier's own dist is all the DB knows,
  // so it is scored as before (the carrier demotes x and y as its twin).
  const { x, y, carrier, target } = fixture(h.path);
  const r = matchInventory(target, loaded([x, y, carrier]));
  assert.equal(tierOf(r, "x-real")?.demotion?.by, "dist-carrier", JSON.stringify(tierOf(r, "x-real")));
  assert.equal(tierOf(r, "dist-carrier")?.tier, "high");
});

test("corpus-db-growth: a package's own path-bearing file keeps the code its own path holds", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  // x-real itself path-bearing: the wrapper's attribution names x-real, so
  // its own claim stays; y-real (pathless) also stays.
  const { y, wrapper, target } = fixture(h.path);
  const xp = signature(h.path, "x-real", [moduleOf("xq", 12, 11)], { paths: ["x-real/index.js"] });
  const r = matchInventory(target, loaded([xp, y, wrapper]));
  assert.equal(tierOf(r, "x-real")?.tier, "high", JSON.stringify(tierOf(r, "x-real")));
  assert.equal(tierOf(r, "y-real")?.tier, "high");
});

test("corpus-db-growth: path attribution to a package with no signature claiming the code does not take it from its claimant", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  // A path-bearing file names x-real's code as `x-fork/...` (a fork, or a
  // package whose own file inlined it), and no loaded x-fork signature holds
  // it. Measured: on Expensify + pop this took hasown, es-define-property and
  // define-properties, and on bluesky color, react-native-svg and
  // react-native-gesture-handler. Only a claimant the attribution names
  // makes the others copies.
  const { x, target } = fixture(h.path);
  const forkWrapper = signature(h.path, "fork-wrapper", [moduleOf("fw", 6, 9101), moduleOf("xq", 12, 11)], { paths: ["fork-wrapper/index.js", "x-fork/index.js"] });
  const r = matchInventory(target, loaded([x, forkWrapper]));
  assert.equal(tierOf(r, "x-real")?.tier, "high", JSON.stringify(tierOf(r, "x-real")));
});

// corpus-db-growth open item 2 (copies over-reach). Bluesky +pop2 lost
// lodash.debounce (eligible 8 -> 2): lodash.throttle's own file inlines
// debounce's helpers, a path-bearing file names that code
// `lodash.throttle/...`, and the loaded throttle signature claims it, so
// debounce's own functions became copies. Both are in the app: the target
// holds each shared helper twice (traced on deb). One attributed package
// accounts for one instance; the second instance is the other claimant's.
test("corpus-db-growth: a hash the target holds more often than its attributed packages account for is not a copy", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  const shared = helpers("dq", 6, 11);
  const DEB = [...shared, ...helpers("du", 1, 501)].join("\n") + "\n" + exportAll([...fnNames("dq", 6), ...fnNames("du", 1)]);
  const THR = [...shared, ...helpers("tu", 1, 801)].join("\n") + "\n" + exportAll([...fnNames("dq", 6), ...fnNames("tu", 1)]);
  const deb = signature(h.path, "deb-real", [DEB]);
  const thr = signature(h.path, "thr-real", [THR]);
  const wrapper = signature(h.path, "wrapper", [moduleOf("wr", 6, 9001), THR], { paths: ["wrapper/index.js", "thr-real/index.js"] });
  const target = buildInventory(compile(h.path, bundle([APP, DEB, THR]))).inventory;
  const before = matchInventory(target, loaded([deb, thr]));
  const grown = matchInventory(target, loaded([deb, thr, wrapper]));
  for (const p of ["deb-real", "thr-real"]) {
    assert.equal(tierOf(grown, p)?.exactHits, tierOf(before, p)?.exactHits, p + " grown: " + JSON.stringify(tierOf(grown, p)) + " before: " + JSON.stringify(tierOf(before, p)));
    assert.equal(tierOf(grown, p)?.tier, tierOf(before, p)?.tier);
  }
  assert.equal(tierOf(grown, "deb-real")?.tier, "high");
  // One instance in the target: the attribution still decides (the
  // carrier case corpus-db-growth fixed is unchanged).
  const single = buildInventory(compile(h.path, bundle([APP, THR]))).inventory;
  const r = matchInventory(single, loaded([deb, thr, wrapper]));
  assert.equal(tierOf(r, "deb-real")?.exactHits, 0, JSON.stringify(tierOf(r, "deb-real")));
});

// Same review: bluesky +pop2 lost react-native-svg to generic 4-24
// instruction functions that expo/cli path-bearing files attribute to ms,
// debug, color-convert, xcode. Code that small is not identifying, so a
// path never makes it someone else's.
test("corpus-db-growth: generic small functions are never attributed away by paths", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  // Small generic helpers (8-20 instructions) the claimant shares with an
  // unrelated package the wrapper bundled under its own path.
  const small = Array.from({ length: 6 }, (_, i) => `function sm${i}(a) { return a === ${i} ? null : a + ${i}; }`);
  const S = [...small, ...helpers("sv", 3, 611)].join("\n") + "\n" + exportAll([...fnNames("sm", 6), ...fnNames("sv", 3)]);
  const svg = signature(h.path, "svg-real", [S]);
  const msModule = [...small, ...helpers("ms", 4, 7301)].join("\n") + "\n" + exportAll([...fnNames("sm", 6), ...fnNames("ms", 4)]);
  const ms = signature(h.path, "ms-like", [msModule]);
  const wrapper = signature(h.path, "wrapper", [moduleOf("wr", 6, 9001), msModule], { paths: ["wrapper/index.js", "ms-like/index.js"] });
  const target = buildInventory(compile(h.path, bundle([APP, S]))).inventory;
  const before = matchInventory(target, loaded([svg, ms]));
  const grown = matchInventory(target, loaded([svg, ms, wrapper]));
  assert.ok(target.functions.some((f) => f.instrCount >= 8 && f.instrCount < 25), "fixture holds small eligible functions");
  assert.equal(tierOf(grown, "svg-real")?.exactHits, tierOf(before, "svg-real")?.exactHits, "grown: " + JSON.stringify(tierOf(grown, "svg-real")) + " before: " + JSON.stringify(tierOf(before, "svg-real")));
  assert.equal(tierOf(grown, "svg-real")?.tier, tierOf(before, "svg-real")?.tier);
});
