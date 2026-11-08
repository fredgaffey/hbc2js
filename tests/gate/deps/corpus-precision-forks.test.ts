// corpus-precision-forks (docs/DEPS.md "Forks, embedded copies and repeated
// hashes"): the false positives left after module paths and the generic-hash
// rule, measured on five truth apps, come from four shapes, each covered
// here on synthetic bundles:
//  - few-distinct: one boilerplate factory the package repeats many times
//    (core-js, deferred, dfa, asynckit, openai on bluesky) collects one
//    module hit per repeat from a single shape in the app;
//  - container: a package's code inlined in a much larger module of the app
//    (process and stackframe inside react-devtools-core/dist/backend.js);
//  - embedded: a package's code inside another confirmed package's own,
//    path-bearing file (oboe in react-native-blob-util, jszip in localforage);
//  - twin: one source under two names (punycode / punycode.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireHermesc } from "../../support/hermesc.ts";
import { buildInventory } from "../../../src/deps/inventory.ts";
import { matchInventory, CONTAINER_SIZE_RATIO, MIN_DISTINCT_EVIDENCE_HASHES } from "../../../src/deps/match.ts";
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
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-forks-"));
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
const BOILER = `var a = require(dependencyMap[0]); var b = require(dependencyMap[1]); exports.default = a && a.__esModule ? a.default : a; exports.extra = b; exports.flag = 17;`;
const APP = `var c = 1; for (var w = 0; w < 19; w++) { c = (c * 31 + w) % 1000003; } module.exports = function appOnly(v) { return c ^ v; };`;

test("corpus-precision-forks: one factory repeated in the package is one piece of evidence (few-distinct)", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  // Like core-js: the shape repeats, and the rest of the package (here
  // three distinct modules) is not in the app.
  const repeat = signature(h.path, "repeat-boiler", [BOILER, BOILER, BOILER, BOILER, BOILER, BOILER, moduleOf("na", 2, 600), moduleOf("nb", 2, 640), moduleOf("nc", 2, 680)]);
  const real = signature(h.path, "three-real", [moduleOf("ra", 2, 1), moduleOf("rb", 2, 50), moduleOf("rc", 2, 90)]);
  // The app has the shape twice (fewer than three copies: not generic).
  const target = buildInventory(compile(h.path, bundle([BOILER, APP, moduleOf("ra", 2, 1), BOILER, moduleOf("rb", 2, 50), moduleOf("rc", 2, 90)]))).inventory;
  const report = matchInventory(target, loaded([repeat, real]));
  assert.ok((tierOf(report, "repeat-boiler")?.moduleExactHits ?? 0) >= 3, "the repeated factory still records its module hits");
  assert.equal(tierOf(report, "repeat-boiler")?.tier, "medium", `one distinct hash is not high: ${JSON.stringify(tierOf(report, "repeat-boiler"))}`);
  assert.equal(tierOf(report, "repeat-boiler")?.demotion?.rule, "few-distinct");
  assert.equal(tierOf(report, "three-real")?.tier, "high", "three distinct modules stay high");
  assert.equal(MIN_DISTINCT_EVIDENCE_HASHES, 3);
});

test("corpus-precision-forks: a copy inlined in a much larger app module is not the package (container)", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  const small = signature(h.path, "small-lib", [moduleOf("sl", 6, 7)]);
  const whole = small.totalFunctions;
  // A pre-built dist file of another package: the same helpers plus far
  // more of its own code, all in ONE module.
  const filler = helpers("big", CONTAINER_SIZE_RATIO * whole + 10, 300);
  const container = [...helpers("sl", 6, 7), ...filler, exportAll([...fnNames("sl", 6), ...fnNames("big", filler.length)])].join("\n");
  const target = buildInventory(compile(h.path, bundle([APP, container]))).inventory;
  const report = matchInventory(target, loaded([small]));
  assert.equal(tierOf(report, "small-lib")?.demotion?.rule, "container", JSON.stringify(tierOf(report, "small-lib")));
  assert.equal(tierOf(report, "small-lib")?.tier, "medium");
  // The same package as its own module stays high.
  const own = matchInventory(buildInventory(compile(h.path, bundle([APP, moduleOf("sl", 6, 7)]))).inventory, loaded([small]));
  assert.equal(tierOf(own, "small-lib")?.tier, "high");
  assert.equal(tierOf(own, "small-lib")?.demotion, undefined);
});

test("corpus-precision-forks: a copy inside another confirmed package's own file goes to that package (embedded)", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  const hostBody = [...helpers("cp", 6, 11), ...helpers("ho", 10, 400), exportAll([...fnNames("cp", 6), ...fnNames("ho", 10)])].join("\n");
  const host = signature(h.path, "host-dist", [hostBody], { paths: ["host-dist/lib/vendored.min.js"] });
  const copy = signature(h.path, "copy-lib", [moduleOf("cp", 6, 11)], { paths: ["copy-lib/index.js"] });
  const target = buildInventory(compile(h.path, bundle([APP, hostBody]))).inventory;
  const report = matchInventory(target, loaded([host, copy]));
  assert.equal(tierOf(report, "host-dist")?.tier, "high");
  assert.deepEqual(tierOf(report, "copy-lib")?.demotion, { rule: "embedded", by: "host-dist" }, JSON.stringify(tierOf(report, "copy-lib")));
  // Pathless host: its signature may still hold its dependencies' code, so
  // it explains nothing (d3-zoom holds d3-ease).
  const { modulePaths: _m, ...pathless } = host;
  const r2 = matchInventory(target, loaded([pathless as SigDbFile, copy]));
  assert.equal(tierOf(r2, "copy-lib")?.tier, "high", "a pathless host does not demote");
});

test("corpus-precision-forks: one source under two names keeps one (twin); a few shared functions are not twins", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  const bodies = [moduleOf("tw", 3, 21), moduleOf("tx", 3, 61), moduleOf("ty", 3, 81)];
  const own = (pkg: string) => ({ paths: bodies.map((_, i) => `${pkg}/lib/m${i}.js`) });
  const a = signature(h.path, "twin-a", bodies, own("twin-a"));
  const b = signature(h.path, "twin-b", bodies, own("twin-b"));
  const target = buildInventory(compile(h.path, bundle([APP, ...bodies, moduleOf("us", 3, 700), moduleOf("ut", 3, 740), moduleOf("uu", 3, 780)]))).inventory;
  const r1 = matchInventory(target, loaded([a, b]));
  assert.equal(tierOf(r1, "twin-a")?.tier, "high");
  assert.deepEqual(tierOf(r1, "twin-b")?.demotion, { rule: "twin", by: "twin-a" }, "same evidence: first by name kept");
  // A confirmed package declaring twin-b as its dependency decides it.
  // A pathless twin loses to a path-bearing one (its hits are that one's
  // own files); two pathless files with the same hits may be a package and
  // a dependent still holding its code (event-target-shim /
  // abort-controller), so both stay.
  const { modulePaths: _ma, ...aPathless } = a;
  const { modulePaths: _mb, ...bPathless } = b;
  const r4 = matchInventory(target, loaded([aPathless as SigDbFile, b]));
  assert.deepEqual(tierOf(r4, "twin-a")?.demotion, { rule: "twin", by: "twin-b" }, "the path-bearing twin is kept");
  const r5 = matchInventory(target, loaded([aPathless as SigDbFile, bPathless as SigDbFile]));
  assert.equal(tierOf(r5, "twin-a")?.tier, "high", "two pathless twins both stay");
  assert.equal(tierOf(r5, "twin-b")?.tier, "high", "two pathless twins both stay");
  const user = signature(h.path, "user-pkg", [moduleOf("us", 3, 700), moduleOf("ut", 3, 740), moduleOf("uu", 3, 780)], { deps: ["twin-b@1.0.0__hbc96.json"] });
  const r2 = matchInventory(target, loaded([a, b, user]));
  assert.equal(tierOf(r2, "twin-b")?.tier, "high", "the declared dependency is kept");
  assert.deepEqual(tierOf(r2, "twin-a")?.demotion, { rule: "twin", by: "twin-b" });
  assert.equal(tierOf(r2, "user-pkg")?.tier, "high");
  // Overlap on one module of three is a dependency chain, not a twin.
  const c = signature(h.path, "sharer", [bodies[0]!, moduleOf("us", 3, 700), moduleOf("ut", 3, 740)]);
  const r3 = matchInventory(target, loaded([a, c]));
  assert.equal(tierOf(r3, "twin-a")?.tier, "high");
  assert.equal(tierOf(r3, "sharer")?.tier, "high");
});
