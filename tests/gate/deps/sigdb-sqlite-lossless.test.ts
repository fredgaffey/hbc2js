// sigdb-sqlite-lossless (docs/PACKAGE-SIGNATURES.md §7, "sqlite rev 3"): the
// sqlite layer stores EVERY SigDbFile field (factoryIsDependency,
// nestedFunctionIndices, subtractedDependencies, bulkBuildFixVersion, function
// owner, ...), so JSON -> sqlite -> read back deep-equals, the independent
// --verify reader agrees, matching scores identically (including a demotion
// that depends on factoryIsDependency), and rev-1/2 DBs migrate in place.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildInventory } from "../../../src/deps/inventory.ts";
import { matchInventory } from "../../../src/deps/match.ts";
import { loadSignatures, writeSignature } from "../../../src/deps/db.ts";
import { openSigDb } from "../../../src/deps/sigdb-sql.ts";
import type { SigDbFile } from "../../../src/deps/sigdb-types.ts";
import { reconstructFingerprint } from "../../../tools/pkgsig/sigdb/import-json.mjs";
import { fingerprintModule, SIG_HASH_SCHEME } from "../../../src/deps/fingerprint.ts";
import { decodeFunction } from "../../../src/disasm/decode.ts";
import { parseHbc } from "../../../src/parse/module.ts";
import { requireHermesc } from "../../support/hermesc.ts";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const h = (c: string) => c.repeat(24);
const norm = (v: unknown): unknown => Array.isArray(v) ? v.map(norm) : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])])) : v;

function synthetic(): SigDbFile & { bulkBuildFixVersion: number } {
  return {
    schema: 2, hashScheme: 2, modulePaths: 1, package: "@scope/lossless", version: "2.3.4-beta.1", hbcVersion: 96,
    totalFunctions: 3, rawFunctionCount: 5, subtractedBaselines: ["_baselines/rn@0.76__hbc96.json", "b2"],
    subtractedDependencies: ["dep-a@1.0.0__hbc96.json", "dep-b@2.0.0__hbc96.json"], bulkBuildFixVersion: 1,
    functions: [
      { index: 0, name: "a", paramCount: 1, instrCount: 40, exactHash: h("1"), fuzzyHash: h("2"), stringSetHash: h("3"), stringCount: 2, owner: "dep-a", moduleId: 0 },
      { index: 1, name: "b", paramCount: 0, instrCount: 41, exactHash: h("4"), fuzzyHash: h("5"), stringSetHash: h("6"), stringCount: 0, owner: null, moduleId: 1 },
      { index: 2, name: "c", paramCount: 2, instrCount: 42, exactHash: h("7"), fuzzyHash: h("8"), stringSetHash: h("9"), stringCount: 1 },
    ],
    modules: [
      { factoryFunctionIndex: 0, localModuleId: 7, depCount: 2, depIds: [1, 2], factoryExactHash: h("1"), factoryFuzzyHash: h("2"), nestedFunctionCount: 2, nestedFunctionIndices: [1, 2], functionSetHash: h("a"), factoryIsBaseline: false, factoryIsDependency: true, path: "lossless/index.js" },
      { factoryFunctionIndex: 1, localModuleId: null, depCount: null, depIds: null, factoryExactHash: null, factoryFuzzyHash: null, nestedFunctionCount: 0, functionSetHash: h("b"), factoryIsBaseline: true, factoryIsDependency: false, path: null },
    ],
    toolchainBaseline: false,
    provenance: { packageSha256: "ab", metroVersion: "0.80", reactNativeVersion: "0.76.0", hermescVersion: 96, hermescRnEra: "rn76", repoCommit: "cafe", builtAt: "2026-11-09T00:00:00.000Z" },
  };
}

test("sigdb-sqlite-lossless: every SigDbFile field round-trips through sqlite (runtime reader and --verify reader)", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-sqlite-lossless-"));
  try {
    const f = synthetic();
    const path = join(dir, "sigdb.sqlite");
    writeSignature(path, f);
    const [back] = loadSignatures([{ name: "shared", dir }]).map((l) => l.file);
    assert.deepEqual(norm(back), norm(f));
    const db = openSigDb(path);
    const fpId = (db.prepare("SELECT fp_id FROM fingerprints").get() as { fp_id: number }).fp_id;
    assert.deepEqual(norm(reconstructFingerprint(db, fpId)), norm(f));
    assert.equal((db.prepare("SELECT value FROM meta WHERE key='schema_rev'").get() as { value: string }).value, "3");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const FN = "function (global, require, importDefault, exportAll, module, exports, dependencyMap)";
const MODS = [
  `{ var t = 0; for (var i = 0; i < 37; i++) { t = t + i * 3 - (i % 5) + (i > 10 ? 2 : 1); } module.exports = function sumOwner(x) { return t + x * 7 - (x % 3); }; }`,
  `{ var s = ""; for (var j = 0; j < 29; j++) { s = s + String.fromCharCode(65 + (j % 26)); } module.exports = function strOwner(n) { return s.slice(n % 5) + s.length * n; }; }`,
];
const JS = "function __d(factory, moduleId, deps) {}\n" + MODS.map((b, id) => `__d(${FN}${b},${id},[]);`).join("\n") + "\n";

test("sigdb-sqlite-lossless: matching over the sqlite copy equals the JSON copy, with a factoryIsDependency demotion in play", (t) => {
  const hc = requireHermesc(t, 96);
  if (hc === null) return;
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-sqlite-lossless-m-"));
  try {
    execFileSync(hc.path, ["-O", "-emit-binary", `-out=${join(dir, "o.hbc")}`, "-"], { input: JS });
    const bytes = new Uint8Array(readFileSync(join(dir, "o.hbc")));
    const mod = parseHbc(bytes);
    const fp = fingerprintModule(mod, decodeFunction);
    const mk = (pkg: string, flag: boolean): SigDbFile => ({
      schema: 2, hashScheme: SIG_HASH_SCHEME, package: pkg, version: "1.0.0", hbcVersion: mod.header.version,
      totalFunctions: fp.functions.length, rawFunctionCount: fp.functions.length, subtractedBaselines: [],
      ...(flag ? { subtractedDependencies: ["dep-x@1.0.0__hbc96.json"] } : {}),
      functions: fp.functions,
      modules: fp.modules.map(({ nestedFunctionIndices, ...m }, i) => ({ ...m, ...(flag ? { nestedFunctionIndices, factoryIsDependency: i === 0 } : {}) })),
      toolchainBaseline: false,
      provenance: { packageSha256: null, metroVersion: null, reactNativeVersion: null, hermescVersion: mod.header.version, hermescRnEra: null, repoCommit: null, builtAt: "2026-11-09T00:00:00.000Z" },
    });
    const files = [mk("plain", false), mk("flagged", true)];
    for (const f of files) writeSignature(join(dir, "sigdb.sqlite"), f);
    const back = loadSignatures([{ name: "shared", dir }]).map((l) => l.file);
    const target = buildInventory(bytes).inventory;
    const loaded = (fs: readonly SigDbFile[]) => fs.map((file) => ({ file, layer: "shared" as const, path: "<x>" }));
    const fromJson = matchInventory(target, loaded(files));
    const fromSql = matchInventory(target, loaded(back));
    assert.deepEqual(fromSql.packages, fromJson.packages);
    const score = (r: typeof fromJson, p: string) => JSON.stringify(r.packages.find((x) => x.package === p));
    assert.notEqual(score(fromJson, "flagged"), score(fromJson, "plain").replace('"plain"', '"flagged"'), "the dependency flag must change scoring, else this test proves nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sigdb-sqlite-lossless: a rev-2 DB migrates in place and still reads/scores as before", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-sqlite-lossless-mig-"));
  try {
    const path = join(dir, "sigdb.sqlite");
    openSigDb(path).close();
    const raw = new DatabaseSync(path);
    raw.exec("ALTER TABLE modules DROP COLUMN factory_is_dependency; ALTER TABLE fingerprints DROP COLUMN subtracted_dependencies; ALTER TABLE fingerprint_functions DROP COLUMN owner_json; UPDATE meta SET value='2' WHERE key='schema_rev';");
    raw.close();
    const reopened = openSigDb(path);
    const cols = (reopened.prepare("PRAGMA table_info(modules)").all() as { name: string }[]).map((c) => c.name);
    assert.ok(cols.includes("factory_is_dependency"));
    reopened.close();
    const f = synthetic();
    writeSignature(path, f);
    assert.deepEqual(norm(loadSignatures([{ name: "shared", dir }])[0]!.file), norm(f));
    // a rev-2-era row (new columns NULL) reads back without the new keys
    const old = new DatabaseSync(path);
    old.exec("UPDATE modules SET factory_is_dependency = NULL, nested_function_indices = NULL; UPDATE fingerprints SET subtracted_dependencies = NULL, bulk_build_fix_version = NULL;");
    old.close();
    const m = loadSignatures([{ name: "shared", dir }])[0]!.file;
    assert.equal(m.subtractedDependencies, undefined);
    assert.equal(m.modules[0]!.factoryIsDependency, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
