// corpus-precision-bundled-dist (population-widening run, docs/DEPS.md
// "Bundled dist files"): `@babel/standalone` is one 6,176-function UMD
// file that inlines its own copies of yallist, lru-cache, semver and
// buffer. On Expensify its 71 hit hashes sit in those packages' small
// target modules (yallist 22 of 25 functions: dense, so `scattered` keeps
// it) and in react-devtools-core's 886-function backend.js (which inlines
// the same libraries); none is a target module anywhere near the size of
// babel.js, so `container` (target module >> package) cannot fire either:
// the package is the larger side. A real copy of a single-file package is
// one target module about that file's size.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireHermesc } from "../../support/hermesc.ts";
import { buildInventory } from "../../../src/deps/inventory.ts";
import { matchInventory, BUNDLED_DIST_MIN_FUNCTIONS, CONTAINER_SIZE_RATIO } from "../../../src/deps/match.ts";
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
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-bundled-dist-"));
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
// An app module with its own code plus, optionally, some foreign source.

test("corpus-precision-bundled-dist: a giant dist file whose hits sit in small modules of other code is not the package", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  const N = BUNDLED_DIST_MIN_FUNCTIONS + 100;
  // One own file of N functions (like babel.js); the app holds two small
  // libraries that the dist file inlined: 20 and 12 of its functions, each
  // its own dense module (so `scattered` anchors them).
  const all = helpers("gd", 32, 51);
  const libA = all.slice(0, 20);
  const libB = all.slice(20, 32);
  const lib = (fns: readonly string[]): string => fns.join("\n") + "\n" + exportAll(fns.map((s) => /^function (\w+)/.exec(s)![1]!));
  // The rest of the bundle: functions of other shapes the app lacks (so
  // slimming drops them, as it drops most of babel.js).
  const ops = ["+", "-", "*", "^", "|"];
  const filler = Array.from({ length: N - 32 }, (_, i) => `function fz${i}(x) { ${`x = (x ${ops[i % 5]} ${i + 3}) % 65521; `.repeat(1 + Math.floor(i / 5))}return x; }`);
  const pkg = signature(h.path, "giant-dist", [lib([...all, ...filler])], { paths: ["giant-dist/dist/bundle.js"] });
  const target = buildInventory(compile(h.path, bundle([APP, lib(libA), lib(libB)]))).inventory;
  const report = matchInventory(target, loaded([pkg]));
  assert.equal(tierOf(report, "giant-dist")?.demotion?.rule, "bundled-dist", JSON.stringify(tierOf(report, "giant-dist")));
  assert.equal(tierOf(report, "giant-dist")?.tier, "medium");
  // The CLI matches slimmed records (deps-slim-sigs), which drop the
  // functions the app does not hold: the own file's size must survive.
  const slim = matchInventory(target, loaded([slimSigFile(pkg, new Map(), slimTargetFor(target))]));
  assert.equal(tierOf(slim, "giant-dist")?.demotion?.rule, "bundled-dist", "slim: " + JSON.stringify(tierOf(slim, "giant-dist")));
});

test("corpus-precision-bundled-dist: a large single-file package present as one module stays high (lodash.js)", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  const N = BUNDLED_DIST_MIN_FUNCTIONS + 100;
  const pkg = signature(h.path, "big-one-file", [moduleOf("bo", N, 61)], { paths: ["big-one-file/lodash.js"] });
  // Another version: the app's module is that file, but only part of it
  // hash-matches. Its size is still well over 1/CONTAINER_SIZE_RATIO of it.
  const part = helpers("bo", N, 61).slice(0, Math.ceil(N / CONTAINER_SIZE_RATIO) + 10);
  const other = helpers("bv", 40, 9000);
  const mod = [...part, ...other].join("\n") + "\n" + exportAll([...part, ...other].map((s) => /^function (\w+)/.exec(s)![1]!));
  const report = matchInventory(buildInventory(compile(h.path, bundle([APP, mod]))).inventory, loaded([pkg]));
  assert.equal(tierOf(report, "big-one-file")?.tier, "high", JSON.stringify(tierOf(report, "big-one-file")));
  assert.equal(tierOf(report, "big-one-file")?.demotion, undefined);
});

test("corpus-precision-bundled-dist: a pathless signature is not judged by file size", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  // Without module paths the "file" is the whole package lumped together
  // (many small modules), so small target modules are normal.
  const N = BUNDLED_DIST_MIN_FUNCTIONS + 100;
  const all = helpers("pl", N, 71);
  const lib = (fns: readonly string[]): string => fns.join("\n") + "\n" + exportAll(fns.map((s) => /^function (\w+)/.exec(s)![1]!));
  const pkg = signature(h.path, "pathless-big", [lib(all)]);
  const target = buildInventory(compile(h.path, bundle([APP, lib(all.slice(0, 20)), lib(all.slice(100, 112))]))).inventory;
  const report = matchInventory(target, loaded([pkg]));
  assert.notEqual(tierOf(report, "pathless-big")?.demotion?.rule, "bundled-dist", JSON.stringify(tierOf(report, "pathless-big")));
});
