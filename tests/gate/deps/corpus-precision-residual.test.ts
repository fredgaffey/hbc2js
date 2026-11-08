// corpus-precision-residual (docs/DEPS.md "Forks, embedded copies and
// repeated hashes", residual mechanisms): a package whose hit hashes are
// small helpers each sitting alone in an unrelated app module, or a few
// among hundreds of another file's functions (ai, ky, culori, swiper and
// lodash-es on Expensify), is not a copy of the package: a real copy is a
// module made mostly of the package's own functions (`scattered`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireHermesc } from "../../support/hermesc.ts";
import { buildInventory } from "../../../src/deps/inventory.ts";
import { matchInventory, ANCHOR_DENSITY, CONTAINER_SIZE_RATIO } from "../../../src/deps/match.ts";
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
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-residual-"));
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
const APP = `var c = 1; for (var w = 0; w < 19; w++) { c = (c * 31 + w) % 1000003; } module.exports = function appOnly(v) { return c ^ v; };`;
// An app module with its own code plus, optionally, some foreign source.
// The foreign functions are exported too (unused ones are optimised away).
const appModule = (tag: string, n: number, seed: number, extra: readonly string[] = []): string =>
  [...helpers(tag, n, seed), ...extra, exportAll([...fnNames(tag, n), ...extra.map((src) => /^function (\w+)/.exec(src)![1]!)])].join("\n");

test("corpus-precision-residual: helpers each alone in an unrelated app module are not the package (scattered)", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  // Like ai: one dist file of many functions, six of them small helpers the
  // app also has, one per app module (a transpiler helper, a shared idiom).
  const pkg = signature(h.path, "spread-lib", [moduleOf("sp", 40, 21)], { paths: ["spread-lib/dist/index.js"] });
  const spread = helpers("sp", 6, 21);
  const target = buildInventory(compile(h.path, bundle([APP, ...spread.map((fn, i) => appModule(`ap${i}_`, 8, 1000 + 50 * i, [fn]))]))).inventory;
  const report = matchInventory(target, loaded([pkg]));
  assert.equal(tierOf(report, "spread-lib")?.demotion?.rule, "scattered", JSON.stringify(tierOf(report, "spread-lib")));
  assert.equal(tierOf(report, "spread-lib")?.tier, "medium");
  // The same six helpers as one module of the app (a real, partial copy
  // of the file) stay high.
  const own = matchInventory(buildInventory(compile(h.path, bundle([APP, moduleOf("sp", 6, 21)]))).inventory, loaded([pkg]));
  assert.equal(tierOf(own, "spread-lib")?.tier, "high", JSON.stringify(tierOf(own, "spread-lib")));
  assert.equal(tierOf(own, "spread-lib")?.demotion, undefined);
});

test("corpus-precision-residual: a few hits among hundreds of another module's functions are not the package (scattered, low density)", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  // Like lodash-es inside lodash/lodash.js: the hits share one target module,
  // but are a small share of it; the module is not CONTAINER_SIZE_RATIO x
  // the package, so `container` does not apply.
  const pkg = signature(h.path, "thin-lib", [moduleOf("th", 60, 31)], { paths: ["thin-lib/dist/index.js"] });
  const fillerCount = Math.ceil(6 / ANCHOR_DENSITY) + 10;
  assert.ok(fillerCount + 6 < CONTAINER_SIZE_RATIO * 60, "test shape: below the container ratio");
  const target = buildInventory(compile(h.path, bundle([APP, appModule("fl", fillerCount, 5000, helpers("th", 6, 31))]))).inventory;
  const report = matchInventory(target, loaded([pkg]));
  assert.deepEqual(tierOf(report, "thin-lib")?.demotion, { rule: "scattered" }, JSON.stringify(tierOf(report, "thin-lib")));
});

test("corpus-precision-residual: a fully matched one-function package stays high (scattered exemption)", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  // cross-fetch / isomorphic-ws: one function, fully present, alone.
  const one = signature(h.path, "one-fn", [helpers("of", 1, 77)[0] + "\nmodule.exports = of0;"], { paths: ["one-fn/index.js"] });
  const r = matchInventory(buildInventory(compile(h.path, bundle([APP, helpers("of", 1, 77)[0] + "\nmodule.exports = of0;"]))).inventory, loaded([one]));
  assert.notEqual(tierOf(r, "one-fn")?.demotion?.rule, "scattered", JSON.stringify(tierOf(r, "one-fn")));
});
