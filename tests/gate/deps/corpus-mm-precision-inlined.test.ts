// corpus-mm-precision-inlined (MetaMask precision, docs/DEPS.md "Inlined
// dependency"): metamask's fast-xml-parser ships one dist file (209
// functions) holding its own parser code and the XML builder that newer
// releases split into the `fast-xml-builder` package. Its newer
// path-bearing signature (fxp.cjs, 126 functions) declares
// `fast-xml-builder` as a dependency. Every fast-xml-builder hit sits in
// that one target module, next to parser code its signature does not
// hold. One target module is one source file, so that file is
// fast-xml-parser's and the builder is inlined in it, not installed.
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
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-inlined-"));
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

const HOST = helpers("hp", 30, 81);
const DEP = helpers("ib", 25, 4001);
const file = (fns: readonly string[]): string => fns.join("\n") + "\n" + exportAll(fns.map((s) => /^function (\w+)/.exec(s)![1]!));
const sigs = (h: string, deps: readonly string[] | undefined): LoadedSig[] => loaded([
  signature(h, "host-parser", [file(HOST)], { paths: ["host-parser/lib/parser.js"], ...(deps === undefined ? {} : { deps }) }),
  signature(h, "inl-builder", [file(DEP)], { paths: ["inl-builder/lib/builder.js"] }),
]);

test("corpus-mm-precision-inlined: a dependency whose hits all sit in its dependent's own file is inlined, not installed", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  const target = buildInventory(compile(h.path, bundle([APP, file([...HOST, ...DEP])]))).inventory;
  const report = matchInventory(target, sigs(h.path, ["inl-builder@1.0.0__hbc96.json"]));
  assert.equal(tierOf(report, "host-parser")?.tier, "high", JSON.stringify(tierOf(report, "host-parser")));
  assert.deepEqual(tierOf(report, "inl-builder")?.demotion, { rule: "inlined", by: "host-parser" }, JSON.stringify(tierOf(report, "inl-builder")));
  assert.equal(tierOf(report, "inl-builder")?.tier, "medium");
});

test("corpus-mm-precision-inlined: the dependency installed as its own module stays high", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  const target = buildInventory(compile(h.path, bundle([APP, file(HOST), file(DEP)]))).inventory;
  const report = matchInventory(target, sigs(h.path, ["inl-builder@1.0.0__hbc96.json"]));
  assert.equal(tierOf(report, "inl-builder")?.tier, "high", JSON.stringify(tierOf(report, "inl-builder")));
  assert.equal(tierOf(report, "host-parser")?.tier, "high");
});

test("corpus-mm-precision-inlined: sharing a file with a package that does not declare it is not enough", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  // React Native's renderer and react-reconciler: Expensify's own
  // react-reconciler module also holds renderer-shaped functions, and RN
  // does not declare the reconciler. Without the declared edge we cannot
  // tell which package owns the file.
  const target = buildInventory(compile(h.path, bundle([APP, file([...HOST, ...DEP])]))).inventory;
  const report = matchInventory(target, sigs(h.path, undefined));
  assert.equal(tierOf(report, "inl-builder")?.tier, "high", JSON.stringify(tierOf(report, "inl-builder")));
  assert.equal(tierOf(report, "host-parser")?.tier, "high");
});
