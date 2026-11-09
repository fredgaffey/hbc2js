// sigdb-strip-embedded: a path-bearing signature file (modulePaths 1) still
// holds copies of other packages' code (a nested or hoisted dependency, a
// Babel runtime helper module). The matcher already scores such a file on its
// own files only (docs/PACKAGE-SIGNATURES.md §7), but the DB-wide index
// builders counted the copies as owners, so the real owner's hashes and
// string sets were never "unique" (docs/DEPS.md "Hop-two candidate expansion":
// is-regex, is-date-object, has-property-descriptors). The candidate hash
// index and the string-set index now ignore a path-bearing file's foreign
// modules; pathless files are read exactly as before. Synthetic DBs only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCandidateHashIndex, buildCandidateStringSetIndex, writeCandidateHashIndex } from "../../../src/deps/hash-index.ts";
import { deriveCandidatePackages } from "../../../src/deps/candidates.ts";
import type { ModuleInventory } from "../../../src/deps/inventory.ts";

const H = (n: number): string => n.toString(16).padStart(24, "0");
interface Fn { h: number; ss?: number; mod?: number }
interface Mod { id: number; factory: number; path: string | null }
function sig(pkg: string, fns: readonly Fn[], mods: readonly Mod[] | null): Record<string, unknown> {
  return {
    schema: 2, hashScheme: 2, package: pkg, version: "1.0.0", hbcVersion: 98, totalFunctions: fns.length, rawFunctionCount: fns.length, subtractedBaselines: [],
    functions: fns.map((f, i) => ({ index: i, name: null, paramCount: 1, instrCount: 20, exactHash: H(f.h), fuzzyHash: H(f.h + 1_000_000), stringSetHash: H(f.ss ?? 0), stringCount: f.ss !== undefined ? 3 : 0, ...(mods !== null && f.mod !== undefined ? { moduleId: f.mod } : {}) })),
    modules: (mods ?? []).map((m) => ({ factoryFunctionIndex: m.factory, localModuleId: m.id, functionSetHash: H(5000 + m.id), nestedFunctionCount: 0, ...(mods !== null ? { path: m.path } : {}) })),
    toolchainBaseline: false,
    provenance: { packageSha256: null, metroVersion: null, reactNativeVersion: null, hermescVersion: 98, hermescRnEra: null, repoCommit: null, builtAt: "2026-01-01" },
    subtractedDependencies: [], ...(mods !== null ? { modulePaths: 1 } : {}),
  };
}
function writeSig(dir: string, file: Record<string, unknown>): void {
  writeFileSync(join(dir, `${String(file.package).replace(/\//g, "__")}@1.0.0__hbc98.json`), JSON.stringify(file));
}
function indexed(text: string): Map<string, string> {
  const lines = text.trim().split("\n");
  const header = JSON.parse(lines[0]!.slice(lines[0]!.indexOf("{"))) as { packages: string[] };
  return new Map(lines.slice(1).map((l) => { const [h, id] = l.split("\t"); return [h!, header.packages[Number(id)]!]; }));
}

// owner-lib: its own file only. carrier: its own file (module 0) plus a hoisted
// copy of owner-lib (module 1, path owner-lib/index.js) and a nested copy of a
// package not in the DB (module 2, path carrier/node_modules/orphan/index.js).
function pathDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-strip-embedded-"));
  writeSig(dir, sig("owner-lib", [{ h: 1, mod: 0 }, { h: 2, ss: 101, mod: 0 }, { h: 3, ss: 102, mod: 0 }], [{ id: 0, factory: 0, path: "owner-lib/index.js" }]));
  writeSig(dir, sig("carrier", [
    { h: 10, mod: 0 }, { h: 11, ss: 110, mod: 0 }, { h: 12, mod: 0 },
    { h: 1, mod: 1 }, { h: 2, ss: 101, mod: 1 }, { h: 3, ss: 102, mod: 1 },
    { h: 40, ss: 140, mod: 2 }, { h: 41, mod: 2 },
  ], [{ id: 0, factory: 0, path: "carrier/index.js" }, { id: 1, factory: 3, path: "owner-lib/index.js" }, { id: 2, factory: 6, path: "carrier/node_modules/orphan/index.js" }]));
  return dir;
}

test("sigdb-strip-embedded: the candidate hash index ignores a path-bearing file's foreign modules", () => {
  const idx = indexed(buildCandidateHashIndex(pathDb(), 98));
  for (const h of [1, 2, 3]) assert.equal(idx.get(H(h)), "owner-lib", `hash ${h} is owner-lib's own file and only carrier's copy of it: unique to owner-lib`);
  for (const h of [10, 11, 12]) assert.equal(idx.get(H(h)), "carrier", `carrier's own hash ${h} stays indexed`);
  for (const h of [40, 41]) assert.ok(!idx.has(H(h)), `a nested copy of a package not in the DB claims nothing (${h})`);
});

test("sigdb-strip-embedded: the hop-two string-set index ignores a path-bearing file's foreign modules", () => {
  const idx = indexed(buildCandidateStringSetIndex(pathDb(), 98));
  assert.equal(idx.get(H(101)), "owner-lib");
  assert.equal(idx.get(H(102)), "owner-lib");
  assert.equal(idx.get(H(110)), "carrier");
  assert.ok(!idx.has(H(140)), "a string set only in a foreign copy is nobody's own evidence");
});

test("sigdb-strip-embedded: back-compat, a pathless file's copies still count as owners", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-strip-embedded-pathless-"));
  writeSig(dir, sig("owner-lib", [{ h: 1 }, { h: 2, ss: 101 }, { h: 3, ss: 102 }], null));
  writeSig(dir, sig("carrier", [{ h: 10 }, { h: 11, ss: 110 }, { h: 12 }, { h: 1 }, { h: 2, ss: 101 }, { h: 3, ss: 102 }, { h: 40, ss: 140 }, { h: 41 }], null));
  const idx = indexed(buildCandidateHashIndex(dir, 98));
  for (const h of [1, 2, 3]) assert.ok(!idx.has(H(h)), `pathless: hash ${h} has two owners`);
  for (const h of [10, 11, 12, 40, 41]) assert.equal(idx.get(H(h)), "carrier");
  const ss = indexed(buildCandidateStringSetIndex(dir, 98));
  assert.ok(!ss.has(H(101)) && !ss.has(H(102)), "pathless: shared string sets stay dropped");
  assert.equal(ss.get(H(140)), "carrier");
});

test("sigdb-strip-embedded: a package whose hashes were only blocked by another file's copy is now proposed; the carrier is not proposed by the copy", () => {
  const dir = pathDb();
  writeCandidateHashIndex(dir, dir, 98);
  const inv = { hbcVersion: 98, totalFunctions: 4, moduledFunctionCount: 4, functions: [1, 2, 3, 999].map((h, i) => ({ index: i, instrCount: 20, exactHash: H(h), fuzzyHash: H(h + 1_000_000), stringSetHash: H(0) })), modules: [{ stringConstants: ["unrelated text"] }] } as unknown as ModuleInventory;
  const cands = deriveCandidatePackages([{ name: "shared" as const, dir }], inv);
  assert.ok(cands.has("owner-lib"), `owner-lib's 3 hashes are unique now; got ${[...cands].join(", ")}`);
  assert.ok(!cands.has("carrier"), "the copy inside carrier is not carrier's evidence");
});
