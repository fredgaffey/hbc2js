// corpus-recall-hop-two: truth packages never proposed because they are only a
// recorded dependency of a candidate that is itself not string-evidenced
// (hop two: a dependency of a dependency-, hash- or scope-proposed package).
// Owner ruling 2026-09-29: second-hop expansion needs the package's OWN
// string evidence, not just the recorded dependency edge. "Own string
// evidence" here (docs/DEPS.md "Hop-two candidate expansion"): at least one
// of the package's own functions (owner null or itself, >= 2 string
// constants) has a string-set hash present in the target, and no other
// package's signature (baselines included) at that HBC version has that
// string set. Synthetic DBs only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveCandidatePackages } from "../../../src/deps/candidates.ts";
import { writeCandidateHashIndex, stringSetIndexFileName, buildCandidateStringSetIndex } from "../../../src/deps/hash-index.ts";
import type { ModuleInventory } from "../../../src/deps/inventory.ts";

const H = (n: number): string => n.toString(16).padStart(24, "0");
interface Fn { h: number; ss?: number; sc?: number; owner?: string }
function sig(pkg: string, fns: readonly Fn[], deps: readonly string[] = [], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 2, hashScheme: 2, package: pkg, version: "1.0.0", hbcVersion: 98, totalFunctions: fns.length, rawFunctionCount: fns.length, subtractedBaselines: [],
    functions: fns.map((f, i) => ({ index: i, name: null, paramCount: 1, instrCount: 20, exactHash: H(f.h), fuzzyHash: H(f.h + 1_000_000), stringSetHash: H(f.ss ?? 0), stringCount: f.sc ?? 0, ...(f.owner !== undefined ? { owner: f.owner } : {}) })),
    modules: [], toolchainBaseline: false,
    provenance: { packageSha256: null, metroVersion: null, reactNativeVersion: null, hermescVersion: 98, hermescRnEra: null, repoCommit: null, builtAt: "2026-01-01" },
    subtractedDependencies: deps.map((d) => `${d.replace(/\//g, "__")}@1.0.0__hbc98.json`), ...extra,
  };
}
function writeSig(dir: string, file: Record<string, unknown>): void {
  writeFileSync(join(dir, `${String(file.package).replace(/\//g, "__")}@${String(file.version)}__hbc${String(file.hbcVersion)}.json`), JSON.stringify(file));
}
// Target functions: exact hashes 900+ (never in any signature), string-set hashes as given.
function inventory(stringSets: readonly number[], strings: readonly string[]): ModuleInventory {
  return { hbcVersion: 98, totalFunctions: stringSets.length, moduledFunctionCount: stringSets.length, functions: stringSets.map((s, i) => ({ index: i, instrCount: 20, exactHash: H(900 + i), fuzzyHash: H(1900 + i), stringSetHash: H(s) })), modules: [{ stringConstants: strings }] } as unknown as ModuleInventory;
}

function fixture(): { dir: string; layers: { name: "shared"; dir: string }[] } {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-hop-two-"));
  // app-root is named in the bundle's strings; hop-one-lib is only its recorded dependency.
  writeSig(dir, sig("app-root", [{ h: 1 }], ["hop-one-lib"]));
  writeSig(dir, sig("hop-one-lib", [{ h: 2 }], ["two-own-evidence", "two-no-evidence", "two-shared-set", "two-single-string", "two-borrowed-set"]));
  writeSig(dir, sig("two-own-evidence", [{ h: 3, ss: 100, sc: 3 }], ["three-own-evidence"]));
  writeSig(dir, sig("two-no-evidence", [{ h: 4, ss: 101, sc: 3 }]));
  writeSig(dir, sig("two-shared-set", [{ h: 5, ss: 102, sc: 4 }]));
  writeSig(dir, sig("someone-else", [{ h: 6, ss: 102, sc: 4 }]));
  writeSig(dir, sig("two-single-string", [{ h: 7, ss: 103, sc: 1 }]));
  // its only matching string set belongs to another package's function (owner field)
  writeSig(dir, sig("two-borrowed-set", [{ h: 8, ss: 104, sc: 3, owner: "someone-else" }]));
  writeSig(dir, sig("three-own-evidence", [{ h: 9, ss: 105, sc: 3 }]));
  writeCandidateHashIndex(dir, dir, 98);
  return { dir, layers: [{ name: "shared", dir }] };
}

test("corpus-recall-hop-two: a dependency of a dependency-proposed package is proposed when one of its own distinctive string sets is in the target", () => {
  const { layers } = fixture();
  const cands = deriveCandidatePackages(layers, inventory([100, 102, 103, 104, 105], ["uses app-root here"]));
  assert.ok(cands.has("hop-one-lib"), "hop one stays as before");
  assert.ok(cands.has("two-own-evidence"), `own unique 3-string set present -> proposed; got ${[...cands].sort().join(", ")}`);
});

test("corpus-recall-hop-two: a hop-two package without own string evidence stays unproposed (absent, shared, single-string or borrowed sets)", () => {
  const { layers } = fixture();
  const cands = deriveCandidatePackages(layers, inventory([100, 102, 103, 104, 105], ["uses app-root here"]));
  assert.ok(!cands.has("two-no-evidence"), "recorded dependency edge alone is not evidence");
  assert.ok(!cands.has("two-shared-set"), "a string set another package also has is not the package's own evidence");
  assert.ok(!cands.has("two-single-string"), "a one-string set is not distinctive");
  assert.ok(!cands.has("two-borrowed-set"), "a function owned by another package is not own evidence");
  assert.ok(!cands.has("three-own-evidence"), "expansion stops at hop two: a hop-two package's dependencies are never expanded");
});

test("corpus-recall-hop-two: no expansion without a string-set index, and none from a directly evidenced package's own dependencies' absence", () => {
  const { dir, layers } = fixture();
  const bare = mkdtempSync(join(tmpdir(), "hbc2js-hop-two-noidx-"));
  for (const p of ["app-root", "hop-one-lib", "two-own-evidence"]) writeFileSync(join(bare, `${p}@1.0.0__hbc98.json`), readFileSync(join(dir, `${p}@1.0.0__hbc98.json`)));
  const cands = deriveCandidatePackages([{ name: "shared", dir: bare }], inventory([100], ["uses app-root here"]));
  assert.ok(cands.has("hop-one-lib") && !cands.has("two-own-evidence"), "a DB without the string-set index proposes nothing at hop two");
  const none = deriveCandidatePackages(layers, inventory([100], ["nothing named"]));
  assert.ok(!none.has("two-own-evidence"), "no hop-one parent -> no hop two");
});

test("corpus-recall-hop-two: the string-set index keeps only sets with >= 2 strings owned by exactly one package at that HBC version", () => {
  const { dir } = fixture();
  assert.ok(existsSync(join(dir, stringSetIndexFileName(98))), "writeCandidateHashIndex writes the string-set index beside the hash index");
  const text = buildCandidateStringSetIndex(dir, 98);
  const lines = text.split("\n").slice(1).filter((l) => l.length > 0).map((l) => l.split("\t")[0]);
  assert.ok(lines.includes(H(100)) && lines.includes(H(101)) && lines.includes(H(105)), "unique multi-string sets are indexed");
  assert.ok(!lines.includes(H(102)), "a set two packages share is dropped");
  assert.ok(!lines.includes(H(103)), "a one-string set is dropped");
  assert.ok(!lines.includes(H(104)), "a set from a function owned by another package is dropped");
  assert.ok(!lines.includes(H(0)), "the empty set is dropped");
});

// deps-hop-two-cascade: the hop-two worker measured react-navigation-example
// 10 -> 18 confirmed on db-v4-paths-partial and saw four more packages
// confirm than the two it admitted. Traced: its "before" run used a stale
// code copy predating corpus-path-recall (promoteViaDependency); with the
// current matcher and the two admitted packages removed from the candidate
// set the app confirms 17, and admitting them adds react-native-pager-view
// only. Pinned here: admitting a hop-two package whose functions share no
// hash with other candidates changes no other package's score.
test("deps-hop-two-cascade: admitting a hop-two package leaves every other candidate's score unchanged", async () => {
  const { loadSignatures } = await import("../../../src/deps/db.ts");
  const { matchInventory } = await import("../../../src/deps/match.ts");
  const { slimTargetFor } = await import("../../../src/deps/slim-sigs.ts");
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-hop-two-cascade-"));
  const fns = (from: number, n: number, extra: Fn[] = []): Fn[] => [...Array.from({ length: n }, (_, i) => ({ h: from + i })), ...extra];
  writeSig(dir, sig("app-root", fns(1, 6), ["hop-one-lib"]));
  writeSig(dir, sig("hop-one-lib", fns(20, 6), ["two-own-evidence"]));
  writeSig(dir, sig("two-own-evidence", fns(40, 6, [{ h: 60, ss: 100, sc: 3 }])));
  writeCandidateHashIndex(dir, dir, 98);
  const layers = [{ name: "shared" as const, dir }];
  const target = [...fns(1, 6), ...fns(20, 6), ...fns(40, 6)].map((f) => f.h);
  const inv = { hbcVersion: 98, totalFunctions: target.length + 1, moduledFunctionCount: target.length + 1, functions: [...target.map((h, i) => ({ index: i, instrCount: 20, exactHash: H(h), fuzzyHash: H(h + 1_000_000), stringSetHash: H(0) })), { index: target.length, instrCount: 20, exactHash: H(999), fuzzyHash: H(1999), stringSetHash: H(100) }], modules: [{ localModuleId: 0, factoryFunctionIndex: 0, depCount: 0, nestedFunctionIndices: [], functionIndices: [], instrCount: 20, exactHash: null, fuzzyHash: null, factoryStringSetHash: null, stringConstants: ["uses app-root here"] }] } as unknown as ModuleInventory;
  const withTwo = deriveCandidatePackages(layers, inv);
  assert.ok(withTwo.has("two-own-evidence"), `hop-two package admitted; got ${[...withTwo].sort().join(", ")}`);
  const without = new Set([...withTwo].filter((p) => p !== "two-own-evidence"));
  const run = (cands: ReadonlySet<string>) => matchInventory(inv, loadSignatures(layers, { candidates: cands, hbcVersion: 98, otherHbcPackages: new Set(), slim: slimTargetFor(inv) }));
  const a = run(without), b = run(withTwo);
  assert.ok(b.packages.some((p) => p.package === "two-own-evidence"), "the admitted package is scored");
  assert.ok(a.packages.some((p) => p.package === "app-root") && a.packages.some((p) => p.package === "hop-one-lib"), "the other candidates are scored in both runs");
  const others = (r: ReturnType<typeof run>) => r.packages.filter((p) => p.package !== "two-own-evidence").sort((x, y) => x.package.localeCompare(y.package));
  assert.deepEqual(others(b), others(a), "no other candidate's score moves when the hop-two package is admitted");
});
