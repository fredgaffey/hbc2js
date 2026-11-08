// sigdb-sqlite-paths (docs/PACKAGE-SIGNATURES.md §7, "sqlite layer"): the
// sigdb v3 sqlite layer stores module paths v1 (module `path`, function
// `moduleId`, the file-level `modulePaths` flag) and the hash scheme, so a
// path-bearing SigDbFile written to sqlite reads back deep-equal and scores
// exactly as the JSON copy does, including the corpus-embedded-copy scenario;
// and an existing sqlite DB from before this change still opens (migrated in
// place) and reads as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { requireHermesc } from "../../support/hermesc.ts";
import { buildInventory } from "../../../src/deps/inventory.ts";
import { matchInventory } from "../../../src/deps/match.ts";
import { fingerprintModule, SIG_HASH_SCHEME } from "../../../src/deps/fingerprint.ts";
import { decodeFunction } from "../../../src/disasm/decode.ts";
import { parseHbc } from "../../../src/parse/module.ts";
import { attachModulePaths, MODULE_PATHS_VERSION, modulePathsFromSourceMap } from "../../../src/deps/module-paths.ts";
import { loadSignatures, writeSignature } from "../../../src/deps/db.ts";
import { openSigDb } from "../../../src/deps/sigdb-sql.ts";
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


function viaSqlite(files: readonly SigDbFile[], dir: string): SigDbFile[] {
  const path = join(dir, "sigdb.sqlite");
  for (const f of files) writeSignature(path, f);
  return loadSignatures([{ name: "shared", dir }]).map((l) => l.file);
}
const bySorted = (fs: readonly SigDbFile[]) => [...fs].sort((a, b) => a.package.localeCompare(b.package));

test("sigdb-sqlite-paths: a path-bearing file round-trips through sqlite deep-equal and scores like the JSON copy", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-sqlite-paths-"));
  try {
    const owner = signature(h.path, "tiny-owner", OWNER_JS, OWNER_SOURCES);
    const impostor = signature(h.path, "tiny-impostor", IMPOSTOR_JS, IMPOSTOR_SOURCES);
    const strip = (f: SigDbFile): SigDbFile => ({ ...f, modules: f.modules.map(({ nestedFunctionIndices: _n, ...m }) => m) });
    const back = bySorted(viaSqlite([owner, impostor], dir));
    assert.deepEqual(back, bySorted([owner, impostor].map(strip)));
    assert.equal(back[0]!.modulePaths, MODULE_PATHS_VERSION);
    assert.equal(back[0]!.hashScheme, SIG_HASH_SCHEME);
    const target = buildInventory(compile(h.path, bundle([O0, O1, APP, O2]))).inventory;
    const asLoaded = (fs: readonly SigDbFile[]) => fs.map((file) => ({ file, layer: "shared" as const, path: "<x>" }));
    const fromJson = matchInventory(target, asLoaded([owner, impostor]));
    const fromSql = matchInventory(target, asLoaded(back));
    assert.deepEqual(fromSql.packages, fromJson.packages);
    assert.notEqual(fromSql.packages.find((s) => s.package === "tiny-impostor")?.tier ?? "none", "high", "embedded copy still does not lift the impostor via sqlite");
    assert.equal(fromSql.packages.find((s) => s.package === "tiny-owner")?.tier, "high");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sigdb-sqlite-paths: a pathless scheme-1 file stays pathless (no modulePaths/path/moduleId/hashScheme appear)", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-sqlite-nopaths-"));
  try {
    const f: SigDbFile = {
      schema: 2, package: "old-pkg", version: "1.0.0", hbcVersion: 94, totalFunctions: 1, rawFunctionCount: 1, subtractedBaselines: [],
      functions: [{ index: 0, name: "a", paramCount: 0, instrCount: 3, exactHash: "1".repeat(24), fuzzyHash: "2".repeat(24), stringSetHash: "3".repeat(24), stringCount: 0 }],
      modules: [{ factoryFunctionIndex: 0, localModuleId: 0, depCount: 0, depIds: [], factoryExactHash: "1".repeat(24), factoryFuzzyHash: "2".repeat(24), nestedFunctionCount: 0, functionSetHash: "4".repeat(24), factoryIsBaseline: false }],
      toolchainBaseline: false,
      provenance: { packageSha256: null, metroVersion: null, reactNativeVersion: null, hermescVersion: 94, hermescRnEra: null, repoCommit: null, builtAt: "2026-11-09T00:00:00.000Z" },
    };
    assert.deepEqual(viaSqlite([f], dir)[0], f);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sigdb-sqlite-paths: a pre-paths sqlite DB opens (migrated in place), reads as before, and accepts path-bearing files", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-sqlite-migrate-"));
  try {
    const path = join(dir, "sigdb.sqlite");
    const old = openSigDb(path);
    old.close();
    // Recreate the pre-change shape: drop the columns this change added.
    const raw = new DatabaseSync(path);
    raw.exec("ALTER TABLE modules DROP COLUMN path; ALTER TABLE fingerprint_functions DROP COLUMN module_id; ALTER TABLE fingerprints DROP COLUMN module_paths; ALTER TABLE fingerprints DROP COLUMN hash_scheme; DELETE FROM meta WHERE key = 'schema_rev';");
    raw.close();
    const reopened = openSigDb(path);
    const cols = (reopened.prepare("PRAGMA table_info(modules)").all() as { name: string }[]).map((c) => c.name);
    assert.ok(cols.includes("path"), "migration added modules.path");
    reopened.close();
    const owner = signature(h.path, "tiny-owner", OWNER_JS, OWNER_SOURCES);
    writeSignature(path, owner);
    const [back] = loadSignatures([{ name: "shared", dir }]).map((l) => l.file);
    assert.equal(back!.modulePaths, MODULE_PATHS_VERSION);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
