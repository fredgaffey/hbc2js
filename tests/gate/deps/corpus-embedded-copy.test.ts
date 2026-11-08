// corpus-embedded-copy (docs/PACKAGE-SIGNATURES.md §7, docs/DEPS.md
// "Offline false positives on J3, by mechanism"): 46 of J3's 72 offline
// false positives were packages whose signature embeds a copy of another
// package that is also in the app (`buffer` inside `safe-buffer`, lodash
// inside `dagre`, `@babel/runtime` helpers inside `bucket`...). The real
// owner and the impostor match identical hashes. Module paths v1 records
// each module's file below node_modules, and matching scores a package on
// its OWN files only.
//
// Synthetic packages: `tiny-owner` (three modules) and `tiny-impostor`
// (one own module + a copy of all three `tiny-owner` modules: two nested
// under `tiny-impostor/node_modules/`, one hoisted). The target app holds
// `tiny-owner` and an app module, never `tiny-impostor`'s own code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireHermesc } from "../../support/hermesc.ts";
import { buildInventory } from "../../../src/deps/inventory.ts";
import { matchInventory } from "../../../src/deps/match.ts";
import { fingerprintModule, SIG_HASH_SCHEME } from "../../../src/deps/fingerprint.ts";
import { decodeFunction } from "../../../src/disasm/decode.ts";
import { parseHbc } from "../../../src/parse/module.ts";
import { attachModulePaths, isOwnModulePath, MODULE_PATHS_VERSION, modulePathsFromSourceMap } from "../../../src/deps/module-paths.ts";
import { confirmCandidates } from "../../../src/deps/confirm.ts";
import type { ConfirmSuccess } from "../../../src/deps/confirm.ts";
import type { LoadedSig } from "../../../src/deps/db.ts";
import type { SigDbFile } from "../../../src/deps/sigdb-types.ts";

const HEAD = "function __d(factory, moduleId, deps) {}";
const FN = "function (global, require, importDefault, exportAll, module, exports, dependencyMap)";
const O0 = `{ var t = 0; for (var i = 0; i < 37; i++) { t = t + i * 3 - (i % 5) + (i > 10 ? 2 : 1); } module.exports = function sumOwner(x) { return t + x * 7 - (x % 3); }; }`;
const O1 = `{ var s = ""; for (var j = 0; j < 29; j++) { s = s + String.fromCharCode(65 + (j % 26)); } module.exports = function strOwner(n) { return s.slice(n % 5) + s.length * n; }; }`;
const O2 = `{ var a = []; for (var k = 0; k < 41; k++) { a.push(k * k - k + 7, k + 1); } module.exports = function arrOwner(q) { return a[q % a.length] * 2 + a.length - q; }; }`;
const I0 = `{ var m = {}; for (var z = 0; z < 23; z++) { m["k" + z] = z * 11 - (z % 7); } module.exports = function impostorOwn(y) { return m["k" + (y % 23)] + y * 5; }; }`;
const APP = `{ var c = 1; for (var w = 0; w < 19; w++) { c = (c * 31 + w) % 1000003; } module.exports = function appOnly(v) { return c ^ v; }; }`;

function bundle(bodies: readonly string[]): string {
  return [HEAD, ...bodies.map((b, id) => `__d(${FN}${b},${id},[]);`)].join("\n") + "\n";
}

// Base64 VLQ, one segment [genCol 0, srcDelta, line 0, col 0] per module line.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function vlq(v: number): string {
  let x = v < 0 ? (-v << 1) | 1 : v << 1;
  let out = "";
  do {
    let d = x & 31;
    x >>>= 5;
    if (x > 0) d |= 32;
    out += B64[d];
  } while (x > 0);
  return out;
}
function sourceMap(sources: readonly string[]): { version: 3; sources: readonly string[]; mappings: string } {
  const lines = [""]; // HEAD line unmapped
  sources.forEach((_, i) => lines.push(`A${vlq(i === 0 ? 0 : 1)}AA`));
  return { version: 3, sources, mappings: lines.join(";") };
}

const ROOT = "/work/scaffold/node_modules/";
const OWNER_SOURCES = [`${ROOT}tiny-owner/index.js`, `${ROOT}tiny-owner/lib/a.js`, `${ROOT}tiny-owner/lib/b.js`];
const IMPOSTOR_SOURCES = [`${ROOT}tiny-impostor/index.js`, `${ROOT}tiny-impostor/node_modules/tiny-owner/index.js`, `${ROOT}tiny-impostor/node_modules/tiny-owner/lib/a.js`, `${ROOT}tiny-owner/lib/b.js`];
const OWNER_JS = bundle([O0, O1, O2]);
const IMPOSTOR_JS = bundle([I0, O0, O1, O2]);

function compile(hermesc: string, js: string): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-embedded-"));
  try {
    execFileSync(hermesc, ["-O", "-emit-binary", `-out=${join(dir, "o.hbc")}`, "-"], { input: js });
    return new Uint8Array(readFileSync(join(dir, "o.hbc")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function signature(hermesc: string, pkg: string, js: string, sources: readonly string[]): SigDbFile {
  const mod = parseHbc(compile(hermesc, js));
  const fp = fingerprintModule(mod, decodeFunction);
  const { functions, modules } = attachModulePaths(mod, decodeFunction, fp.functions, fp.modules.map(({ nestedFunctionIndices: _n, ...m }) => m), modulePathsFromSourceMap(sourceMap(sources), js));
  return {
    schema: 2, hashScheme: SIG_HASH_SCHEME, modulePaths: MODULE_PATHS_VERSION, package: pkg, version: "1.0.0", hbcVersion: mod.header.version,
    totalFunctions: functions.length, rawFunctionCount: functions.length, subtractedBaselines: [], functions, modules, toolchainBaseline: false,
    provenance: { packageSha256: null, metroVersion: null, reactNativeVersion: null, hermescVersion: mod.header.version, hermescRnEra: null, repoCommit: null, builtAt: "2026-11-09T00:00:00.000Z" },
  };
}

/** The same file as an old (pre-paths) scheme-2 signature. */
function stripPaths(f: SigDbFile): SigDbFile {
  const { modulePaths: _p, ...rest } = f;
  return { ...rest, functions: f.functions.map(({ moduleId: _m, ...fn }) => fn), modules: f.modules.map(({ path: _q, ...m }) => m) };
}

const loaded = (files: readonly SigDbFile[]): LoadedSig[] => files.map((file) => ({ file, layer: "shared", path: `<${file.package}>` }));

test("corpus-embedded-copy: isOwnModulePath — own file, nested copy, sibling package, scoped, neutral null", () => {
  assert.equal(isOwnModulePath("safe-buffer", "safe-buffer/index.js"), true);
  assert.equal(isOwnModulePath("safe-buffer", "safe-buffer/node_modules/buffer/index.js"), false);
  assert.equal(isOwnModulePath("safe-buffer", "buffer/index.js"), false);
  assert.equal(isOwnModulePath("safe-buffer", "safe-buffer-x/index.js"), false);
  assert.equal(isOwnModulePath("@babel/runtime", "@babel/runtime/helpers/interopRequireDefault.js"), true);
  assert.equal(isOwnModulePath("bucket", "@babel/runtime/helpers/interopRequireDefault.js"), false);
  assert.equal(isOwnModulePath("bucket", null), true);
});

test("corpus-embedded-copy: modulePathsFromSourceMap keeps a nested copy's parent prefix", () => {
  const paths = modulePathsFromSourceMap(sourceMap(IMPOSTOR_SOURCES), IMPOSTOR_JS);
  assert.deepEqual([...paths], [[0, "tiny-impostor/index.js"], [1, "tiny-impostor/node_modules/tiny-owner/index.js"], [2, "tiny-impostor/node_modules/tiny-owner/lib/a.js"], [3, "tiny-owner/lib/b.js"]]);
});

test("corpus-embedded-copy: an embedded copy never lifts the impostor; the real owner stays high and owns the modules", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  const owner = signature(h.path, "tiny-owner", OWNER_JS, OWNER_SOURCES);
  const impostor = signature(h.path, "tiny-impostor", IMPOSTOR_JS, IMPOSTOR_SOURCES);
  assert.equal(impostor.modules.filter((m) => m.path !== null && !isOwnModulePath("tiny-impostor", m.path)).length, 3, "sanity: three foreign modules recorded");
  assert.ok(impostor.functions.some((f) => f.moduleId === 3), "sanity: nested closures carry their module id");
  const target = buildInventory(compile(h.path, bundle([O0, O1, APP, O2]))).inventory;

  const report = matchInventory(target, loaded([owner, impostor]));
  const score = (p: string) => report.packages.find((s) => s.package === p);
  assert.equal(score("tiny-owner")?.tier, "high", "the real owner reaches high");
  assert.notEqual(score("tiny-impostor")?.tier ?? "none", "high", `the impostor must not reach high: ${JSON.stringify(score("tiny-impostor"))}`);
  assert.equal(score("tiny-impostor")?.moduleExactHits ?? 0, 0, "no module hit: the impostor's own module isn't in the app");
  // At most the bundle's global function (outside every module, neutral;
  // a real build subtracts it as toolchain baseline).
  assert.ok((score("tiny-impostor")?.exactHits ?? 0) <= 1, "no exact hit on the impostor's copied code");
  const attributed = report.moduleAttributions.filter((m) => m.owners.length > 0);
  assert.equal(attributed.length, 3, "the three owner modules are attributed");
  for (const m of attributed) assert.deepEqual(m.owners, ["tiny-owner@1.0.0"], "a multi-owner hash goes to the package whose own file it is");

  // The impostor really in the app too: scored on its own module only.
  const target2 = buildInventory(compile(h.path, bundle([O0, O1, APP, O2, I0]))).inventory;
  const both = matchInventory(target2, loaded([owner, impostor]));
  assert.equal(both.packages.find((s) => s.package === "tiny-impostor")?.moduleExactHits, 1, "own module counts");
  assert.equal(both.packages.find((s) => s.package === "tiny-impostor")?.moduleTotal, 1, "foreign modules leave the denominator");
});

test("corpus-embedded-copy: back-compat — the same signatures without paths score exactly as before (impostor high)", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  const owner = stripPaths(signature(h.path, "tiny-owner", OWNER_JS, OWNER_SOURCES));
  const impostor = stripPaths(signature(h.path, "tiny-impostor", IMPOSTOR_JS, IMPOSTOR_SOURCES));
  const target = buildInventory(compile(h.path, bundle([O0, O1, APP, O2]))).inventory;
  const report = matchInventory(target, loaded([owner, impostor]));
  assert.equal(report.packages.find((s) => s.package === "tiny-impostor")?.tier, "high", "pre-paths behaviour: the embedded copy makes the impostor high");
  assert.equal(report.packages.find((s) => s.package === "tiny-impostor")?.moduleTotal, 4);
  // A mixed DB: a path-bearing owner never changes how a pathless impostor scores.
  const mixed = matchInventory(target, loaded([signature(h.path, "tiny-owner", OWNER_JS, OWNER_SOURCES), impostor]));
  assert.deepEqual(mixed.packages.find((s) => s.package === "tiny-impostor"), report.packages.find((s) => s.package === "tiny-impostor"));
});

// --- the builder wiring: confirmCandidates asks Metro for a source map ----

const FAKE_NPM = `#!/usr/bin/env node
"use strict";
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "install") {
  const spec = args.filter((a) => !a.startsWith("--")).pop();
  const pkg = spec.slice(0, spec.lastIndexOf("@"));
  const dir = join(process.cwd(), "node_modules", ...pkg.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: pkg, version: "1.0.0" }));
}
process.exit(0);
`;

// Picks the canned bundle by the entry file's package slug; writes the map
// only when asked (`--sourcemap-output`), like Metro.
const FAKE_NPX = `#!/usr/bin/env node
"use strict";
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const at = (f) => args[args.indexOf(f) + 1];
const bundles = JSON.parse(process.env.HBC2JS_TEST_EMBEDDED_BUNDLES);
const entry = at("--entry-file");
const key = Object.keys(bundles).sort((a, b) => b.length - a.length).find((k) => entry.includes("_" + k + "__"));
writeFileSync(at("--bundle-output"), bundles[key].js);
if (args.includes("--sourcemap-output")) writeFileSync(at("--sourcemap-output"), JSON.stringify(bundles[key].map));
process.exit(0);
`;

test("corpus-embedded-copy: confirmCandidates writes path-bearing signatures; the impostor is not confirmed", async (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  const work = mkdtempSync(join(tmpdir(), "hbc2js-embedded-confirm-"));
  const originalPath = process.env.PATH;
  try {
    const binDir = join(work, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "npm"), FAKE_NPM);
    writeFileSync(join(binDir, "npx"), FAKE_NPX);
    chmodSync(join(binDir, "npm"), 0o755);
    chmodSync(join(binDir, "npx"), 0o755);
    process.env.PATH = `${binDir}:${originalPath}`;
    process.env.HBC2JS_TEST_EMBEDDED_BUNDLES = JSON.stringify({
      "tiny-owner": { js: OWNER_JS, map: sourceMap(OWNER_SOURCES) },
      "tiny-impostor": { js: IMPOSTOR_JS, map: sourceMap(IMPOSTOR_SOURCES) },
    });
    const scratchProjectDir = join(work, "scratch");
    mkdirSync(join(scratchProjectDir, "node_modules", "react-native"), { recursive: true });
    writeFileSync(join(scratchProjectDir, "node_modules", "react-native", "package.json"), JSON.stringify({ name: "react-native", version: "0.0.0-test" }));
    const target = buildInventory(compile(h.path, bundle([O0, O1, APP, O2]))).inventory;
    const results = await confirmCandidates([{ package: "tiny-owner", version: "1.0.0" }, { package: "tiny-impostor", version: "1.0.0" }], target, {
      scratchProjectDir, rnVersion: "0.0.0-test", hbcVersion: 96, hermescPath: h.path, projectDbDir: join(work, "db"), rateLimitMs: 0,
      fingerprintCacheDir: join(work, "fp"),
      fetchVersionTimes: async () => ({ "0.0.0-test": "2026-08-26T00:00:00.000Z" }),
    });
    const owner = results.find((r) => r.candidate.package === "tiny-owner")!;
    const impostor = results.find((r) => r.candidate.package === "tiny-impostor")!;
    assert.equal(owner.ok, true, JSON.stringify(owner));
    const written = JSON.parse(readFileSync((owner as ConfirmSuccess).writtenTo[0]!, "utf8")) as SigDbFile;
    assert.equal(written.modulePaths, MODULE_PATHS_VERSION);
    assert.deepEqual(written.modules.map((m) => m.path), ["tiny-owner/index.js", "tiny-owner/lib/a.js", "tiny-owner/lib/b.js"]);
    assert.equal(impostor.ok, false, `impostor confirmed on an embedded copy: ${JSON.stringify(impostor)}`);
  } finally {
    process.env.PATH = originalPath;
    delete process.env.HBC2JS_TEST_EMBEDDED_BUNDLES;
    rmSync(work, { recursive: true, force: true });
  }
});
