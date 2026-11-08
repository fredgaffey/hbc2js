// corpus-recall-candidates: truth packages whose signature IS in the DB at the
// target's HBC version but which candidate pre-selection never proposed
// (no literal name in the bundle's strings, no dependency edge from a
// directly-evidenced package). Measured on five truth apps against db-v3-clean
// (docs/DEPS.md "Hash-index candidate proposal"): the dominant reason was
// "its own function hashes are present in the target, nothing names it".
// The fix is a precomputed reverse index (hash -> owning packages) per HBC
// version, stored beside the signature files; these tests use synthetic DBs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveCandidatePackages } from "../../../src/deps/candidates.ts";
import { buildCandidateHashIndex, writeCandidateHashIndex, hashIndexFileName, proposeFromHashIndex } from "../../../src/deps/hash-index.ts";
import type { ModuleInventory } from "../../../src/deps/inventory.ts";

const H = (n: number): string => n.toString(16).padStart(24, "0");
function sig(pkg: string, version: string, fns: ReadonlyArray<{ h: number; instr?: number; owner?: string }>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 2, hashScheme: 2, package: pkg, version, hbcVersion: 98, totalFunctions: fns.length, rawFunctionCount: fns.length, subtractedBaselines: [],
    functions: fns.map((f, i) => ({ index: i, name: null, paramCount: 1, instrCount: f.instr ?? 20, exactHash: H(f.h), fuzzyHash: H(f.h + 1_000_000), stringSetHash: H(0), stringCount: 1, ...(f.owner !== undefined ? { owner: f.owner } : {}) })),
    modules: [], toolchainBaseline: false,
    provenance: { packageSha256: null, metroVersion: null, reactNativeVersion: null, hermescVersion: 98, hermescRnEra: null, repoCommit: null, builtAt: "2026-01-01" },
    subtractedDependencies: [], ...extra,
  };
}
function writeSig(dir: string, file: Record<string, unknown>): void {
  writeFileSync(join(dir, `${String(file.package).replace(/\//g, "__")}@${String(file.version)}__hbc${String(file.hbcVersion)}.json`), JSON.stringify(file));
}
function inventory(hashes: readonly number[], strings: readonly string[] = ["unrelated text"], hbcVersion = 98): ModuleInventory {
  return { hbcVersion, totalFunctions: hashes.length, moduledFunctionCount: hashes.length, functions: hashes.map((h, i) => ({ index: i, instrCount: 20, exactHash: H(h), fuzzyHash: H(h + 1_000_000), stringSetHash: H(0) })), modules: [{ stringConstants: strings }] } as unknown as ModuleInventory;
}

test("corpus-recall-candidates: a package with no name or dependency evidence is proposed when >= 2 of its distinctive function hashes appear in the target", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-recall-cand-"));
  writeSig(dir, sig("is-callable-like", "1.2.7", [{ h: 1 }, { h: 2 }, { h: 3 }]));
  writeSig(dir, sig("one-hit-only", "1.0.0", [{ h: 10 }, { h: 11 }]));
  writeSig(dir, sig("absent-package", "2.0.0", [{ h: 20 }, { h: 21 }]));
  writeCandidateHashIndex(dir, dir, 98);
  const layers = [{ name: "shared" as const, dir }];
  const cands = deriveCandidatePackages(layers, inventory([1, 2, 10, 99]));
  assert.ok(cands.has("is-callable-like"), `hash evidence (2 distinct indexed hashes) must propose the package; got ${[...cands].join(", ")}`);
  assert.ok(!cands.has("one-hit-only"), "a single shared hash is not enough evidence to propose a package");
  assert.ok(!cands.has("absent-package"), "a package with no hashes in the target must not be proposed");
});

test("corpus-recall-candidates: the index keeps only distinctive own hashes (min instr, owner, <= maxOwners packages, matching hbc, scheme 2, non-baseline)", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-recall-idx-"));
  // hash 5 is owned by three packages -> generic, dropped at maxOwners 2.
  writeSig(dir, sig("pkg-a", "1.0.0", [{ h: 1 }, { h: 5 }, { h: 6, instr: 3 }, { h: 7, owner: "some-dep" }]));
  writeSig(dir, sig("pkg-a", "1.1.0", [{ h: 1 }, { h: 2 }]));
  writeSig(dir, sig("pkg-b", "1.0.0", [{ h: 5 }, { h: 3 }]));
  writeSig(dir, sig("pkg-c", "1.0.0", [{ h: 5 }, { h: 4 }]));
  writeSig(dir, sig("old-scheme", "1.0.0", [{ h: 30 }], { hashScheme: undefined }));
  writeSig(dir, sig("baseline-thing", "1.0.0", [{ h: 31 }], { toolchainBaseline: true }));
  writeSig(dir, sig("other-hbc", "1.0.0", [{ h: 32 }], { hbcVersion: 96 }));
  const text = buildCandidateHashIndex(dir, 98);
  const lines = text.trim().split("\n");
  const header = JSON.parse(lines[0]!.slice(lines[0]!.indexOf("{"))) as { packages: string[]; hbcVersion: number; minInstr: number; maxOwners: number };
  assert.equal(header.hbcVersion, 98);
  const indexed = new Map(lines.slice(1).map((l) => { const [h, ids] = l.split("\t"); return [h!, ids!.split(",").map((i) => header.packages[Number(i)]!).sort()]; }));
  assert.deepEqual(indexed.get(H(1)), ["pkg-a"], "a hash shared by two versions of one package counts as one owner");
  assert.deepEqual(indexed.get(H(2)), ["pkg-a"]);
  assert.ok(!indexed.has(H(5)), "a hash owned by 3 packages is not distinctive");
  assert.ok(!indexed.has(H(6)), "functions under minInstr are not indexed");
  assert.ok(!indexed.has(H(7)), "a function owned by another package is not indexed under this one");
  for (const h of [30, 31, 32]) assert.ok(!indexed.has(H(h)), `scheme-1, baseline and other-hbc files are not indexed (${h})`);
  assert.deepEqual([...lines.slice(1)].sort(), lines.slice(1), "lines are sorted by hash (deterministic output)");
});

test("corpus-recall-candidates: no index file, or an index for another HBC version, leaves candidates unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-recall-none-"));
  writeSig(dir, sig("is-callable-like", "1.2.7", [{ h: 1 }, { h: 2 }]));
  const layers = [{ name: "shared" as const, dir }];
  assert.ok(!deriveCandidatePackages(layers, inventory([1, 2])).has("is-callable-like"), "without an index nothing is hash-proposed");
  writeSig(dir, sig("is-callable-like", "1.2.7", [{ h: 1 }, { h: 2 }], { hbcVersion: 96 }));
  writeCandidateHashIndex(dir, dir, 96);
  assert.ok(existsSync(join(dir, hashIndexFileName(96))));
  assert.ok(!deriveCandidatePackages(layers, inventory([1, 2])).has("is-callable-like"), "an hbc96 index is never consulted for an hbc98 target");
  assert.ok(deriveCandidatePackages(layers, inventory([1, 2], undefined, 96)).has("is-callable-like"));
});

test("corpus-recall-candidates: a hash-proposed package's recorded dependencies are not expanded (no stacked inference)", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-recall-dep-"));
  writeSig(dir, sig("hash-host", "1.0.0", [{ h: 1 }, { h: 2 }], { subtractedDependencies: ["leaf-of-hash-host@1.0.0__hbc98.json"] }));
  writeSig(dir, sig("leaf-of-hash-host", "1.0.0", [{ h: 40 }]));
  writeCandidateHashIndex(dir, dir, 98);
  const cands = deriveCandidatePackages([{ name: "shared" as const, dir }], inventory([1, 2]));
  assert.ok(cands.has("hash-host"));
  assert.ok(!cands.has("leaf-of-hash-host"), "dependency expansion stays one hop from string-evidenced packages only");
});

test("corpus-recall-candidates: proposeFromHashIndex reads the index without parsing signature files and honours minHits", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-recall-hits-"));
  writeSig(dir, sig("three-fn", "1.0.0", [{ h: 1 }, { h: 2 }, { h: 3 }]));
  const out = mkdtempSync(join(tmpdir(), "hbc2js-recall-out-"));
  const path = writeCandidateHashIndex(dir, out, 98);
  assert.equal(path, join(out, hashIndexFileName(98)));
  assert.ok(readFileSync(path, "utf8").startsWith("#hbc2js-candidate-hash-index"));
  const layers = [{ name: "shared" as const, dir: out }];
  assert.deepEqual([...proposeFromHashIndex(layers, inventory([1, 2]))], ["three-fn"]);
  assert.deepEqual([...proposeFromHashIndex(layers, inventory([1, 2]), { minHits: 3 })], []);
  assert.deepEqual([...proposeFromHashIndex(layers, inventory([1, 2, 3]), { minHits: 3 })], ["three-fn"]);
});
