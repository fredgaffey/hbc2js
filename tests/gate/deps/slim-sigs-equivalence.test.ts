// deps-slim-sigs: `loadSignatures({slim:true})` projects each parsed signature
// file to the compact record the matcher reads; matchInventory results must be
// deep-equal to the full-load path, and slim records must lack dropped fields.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadSignatures, type DbLayer } from "../../../src/deps/db.ts";
import { matchInventory } from "../../../src/deps/match.ts";
import type { ModuleInventory } from "../../../src/deps/inventory.ts";
import type { SigDbFile, SigFunction, SigModule } from "../../../src/deps/sigdb-types.ts";

const dir = mkdtempSync(join(tmpdir(), "slim-sigs-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const h = (s: string, n = 0): string => (s + n).padEnd(32, "0");
function fn(index: number, tag: string, extra: Partial<SigFunction> = {}): SigFunction {
  return { index, name: `f${index}`, paramCount: 2, instrCount: 40, exactHash: h("e" + tag), fuzzyHash: h("f" + tag), stringSetHash: h("s" + tag), stringCount: 3, owner: "x", ...extra };
}
function mod(fi: number, tag: string, extra: Partial<SigModule> = {}): SigModule {
  return { factoryFunctionIndex: fi, localModuleId: fi, depCount: 1, depIds: [1], factoryExactHash: h("e" + tag), factoryFuzzyHash: h("f" + tag), nestedFunctionCount: 2, functionSetHash: h("set" + tag), factoryIsBaseline: false, ...extra };
}
function sig(pkg: string, version: string, hbc: number, tags: string[], extra: Partial<SigDbFile> = {}): SigDbFile {
  return {
    schema: 2, package: pkg, version, hbcVersion: hbc, totalFunctions: tags.length, rawFunctionCount: tags.length, subtractedBaselines: ["b"],
    functions: tags.map((t, i) => fn(i, t)), modules: tags.map((t, i) => mod(i, t)), toolchainBaseline: false,
    provenance: { packageSha256: "a", metroVersion: "1", reactNativeVersion: "2", hermescVersion: 96, hermescRnEra: null, repoCommit: null, builtAt: "now" },
    ...extra,
  };
}
const files: SigDbFile[] = [
  sig("alpha", "1.0.0", 96, ["a1", "a2", "a3", "shared"]),
  sig("beta", "1.0.0", 96, ["b1", "b2", "shared"], { hashScheme: 2 }),
  sig("gamma", "2.0.0", 96, ["g1", "g2", "g3", "g4"], { subtractedDependencies: [] }),
  sig("gamma", "1.0.0", 96, ["g1", "g2"]), // superseded by v2 gamma
  sig("alpha", "1.0.0", 98, ["x1", "x2"]), // other hbc version: dropped by the filter
  sig("paths", "1.0.0", 96, ["p1", "p2"], { modulePaths: 1 }),
];
files[5] = { ...files[5]!, modules: [mod(0, "p1", { path: "paths/index.js" }), mod(1, "p2", { path: "other/index.js" })], functions: [fn(0, "p1", { moduleId: 0 }), fn(1, "p2", { moduleId: 1 })] };
mkdirSync(join(dir, "_baselines"), { recursive: true });
for (const f of files) writeFileSync(join(dir, `${f.package}@${f.version}__hbc${f.hbcVersion}.json`), JSON.stringify(f));
writeFileSync(join(dir, "_baselines", "react-foundation@1__hbc96.json"), JSON.stringify(sig("react-foundation", "1", 96, ["shared", "z"], { toolchainBaseline: true })));
const layers: DbLayer[] = [{ name: "project", dir }];

const tags = ["a1", "a2", "a3", "shared", "b1", "g1", "g2", "g3", "g4", "p1", "p2", "z"];
const inventory: ModuleInventory = {
  hbcVersion: 96, totalFunctions: tags.length, moduledFunctionCount: tags.length,
  functions: tags.map((t, i) => fn(i, t)),
  modules: tags.map((t, i) => ({ localModuleId: i, factoryFunctionIndex: i, depCount: 0, nestedFunctionIndices: [], instrCount: 40, stringConstants: ["s"], exactHash: h("e" + t), fuzzyHash: h("f" + t), factoryStringSetHash: h("s" + t), factoryStringCount: 3, legacyExactHash: null, legacyFuzzyHash: null })) as unknown as ModuleInventory["modules"],
};

describe("deps-slim-sigs", () => {
  it("matchInventory over slim records deep-equals the full-load path (hbcVersion filter included)", () => {
    const fullOther = new Set<string>();
    const slimOther = new Set<string>();
    const full = loadSignatures(layers, { hbcVersion: 96, otherHbcPackages: fullOther });
    const slim = loadSignatures(layers, { hbcVersion: 96, otherHbcPackages: slimOther, slim: true });
    assert.deepEqual(slim.map((s) => `${s.file.package}@${s.file.version}`), full.map((s) => `${s.file.package}@${s.file.version}`));
    assert.deepEqual([...slimOther], [...fullOther]);
    const a = matchInventory(inventory, full);
    const b = matchInventory(inventory, slim);
    assert.ok(a.packages.length > 2);
    assert.deepEqual(b, a);
    // no hbcVersion filter either
    assert.deepEqual(matchInventory(inventory, loadSignatures(layers, { slim: true })), matchInventory(inventory, loadSignatures(layers)));
  });

  it("slim records drop the fields the matcher never reads", () => {
    const [first] = loadSignatures(layers, { hbcVersion: 96, slim: true });
    const f = first!.file as unknown as { functions: Record<string, unknown>[]; modules: Record<string, unknown>[]; provenance?: unknown; subtractedBaselines?: unknown };
    assert.equal(f.provenance, undefined);
    assert.equal(f.subtractedBaselines, undefined);
    for (const x of f.functions) for (const k of ["name", "paramCount", "owner"]) assert.equal(k in x, false);
    for (const m of f.modules) for (const k of ["depIds", "depCount", "functionSetHash", "nestedFunctionCount"]) assert.equal(k in m, false);
  });
});
