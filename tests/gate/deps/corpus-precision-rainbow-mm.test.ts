// corpus-precision-rainbow-mm (full db-v4-paths over db-v3-clean, rainbow
// and metamask own builds, docs/DEPS.md "Rainbow and metamask on the full
// path-bearing DB"): `async-lock` (21 functions, rainbow) sits inside
// @rudderstack/rudder-sdk-react-native's 111-function pre-built dist
// module, and `preact` (46 functions) inside @sentry-internal/feedback's
// 234-function one. `container` should have demoted both (target module
// more than 4x the whole package), but it sized the package by
// `rawFunctionCount` too, which on a path-bearing signature counts the
// builder bundle's toolchain and runtime modules (98 for async-lock, 123
// for preact), so the 4x bound was 392 / 492 functions and never reached.
// On a path-bearing signature those modules are separate, unowned files:
// the package's whole is its own `totalFunctions`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireHermesc } from "../../support/hermesc.ts";
import { buildInventory } from "../../../src/deps/inventory.ts";
import { matchInventory, CONTAINER_SIZE_RATIO } from "../../../src/deps/match.ts";
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
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-rainbow-mm-"));
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

// A path-bearing signature of one own file of `n` functions whose builder
// bundle also held `raw - n` toolchain/runtime functions (other modules,
// subtracted from `functions` but still counted in rawFunctionCount).
const withRaw = (f: SigDbFile, raw: number): SigDbFile => ({ ...f, rawFunctionCount: raw });

test("corpus-precision-rainbow-mm: a small path-bearing package inlined in another package's dist module is a container hit (async-lock)", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  const own = helpers("al", 20, 81);
  const pkg = withRaw(signature(h.path, "inl-lock", [own.join("\n") + "\n" + exportAll(fnNames("al", 20))], { paths: ["inl-lock/lib/index.js"] }), 98);
  // The host: one dist module of 20 + 90 functions (more than 4x 20).
  const rest = helpers("rs", 90, 4000);
  const host = [...own, ...rest].join("\n") + "\n" + exportAll([...fnNames("al", 20), ...fnNames("rs", 90)]);
  assert.ok(111 > CONTAINER_SIZE_RATIO * 20 && 111 < CONTAINER_SIZE_RATIO * 98);
  const target = buildInventory(compile(h.path, bundle([APP, host]))).inventory;
  const report = matchInventory(target, loaded([pkg]));
  assert.equal(tierOf(report, "inl-lock")?.demotion?.rule, "container", JSON.stringify(tierOf(report, "inl-lock")));
  assert.equal(tierOf(report, "inl-lock")?.tier, "medium");
  const slim = matchInventory(target, loaded([slimSigFile(pkg, new Map(), slimTargetFor(target))]));
  assert.equal(tierOf(slim, "inl-lock")?.demotion?.rule, "container", "slim: " + JSON.stringify(tierOf(slim, "inl-lock")));
});

test("corpus-precision-rainbow-mm: the same package as its own module stays high", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  const pkg = withRaw(signature(h.path, "own-lock", [moduleOf("ol", 20, 91)], { paths: ["own-lock/lib/index.js"] }), 98);
  const target = buildInventory(compile(h.path, bundle([APP, moduleOf("ol", 20, 91), moduleOf("zz", 90, 5000)]))).inventory;
  const report = matchInventory(target, loaded([pkg]));
  assert.equal(tierOf(report, "own-lock")?.tier, "high", JSON.stringify(tierOf(report, "own-lock")));
  assert.equal(tierOf(report, "own-lock")?.demotion, undefined);
});

test("corpus-precision-rainbow-mm: a pathless signature keeps the raw count as its size", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  // Pathless: the toolchain functions are not told apart from the
  // package's, so the conservative (larger) size stays.
  const own = helpers("pq", 20, 101);
  const pkg = withRaw(signature(h.path, "pathless-lock", [own.join("\n") + "\n" + exportAll(fnNames("pq", 20))]), 98);
  const host = [...own, ...helpers("ps", 90, 6000)].join("\n") + "\n" + exportAll([...fnNames("pq", 20), ...fnNames("ps", 90)]);
  const report = matchInventory(buildInventory(compile(h.path, bundle([APP, host]))).inventory, loaded([pkg]));
  assert.equal(tierOf(report, "pathless-lock")?.tier, "high", JSON.stringify(tierOf(report, "pathless-lock")));
});
