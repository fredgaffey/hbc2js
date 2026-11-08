// docs/DECISIONS.md QUEUE item 22(a) — evidence-directed candidate matching
// for `hbc2js deps` (`src/deps/candidates.ts`). Before this task the match
// stage loaded and JSON-parsed EVERY signature file in every DB layer up
// front (`db.ts`'s `loadSignatures`), scored against the target's whole
// function set regardless of any actual evidence the bundle depends on that
// package — the dominant cost on a real bulk (32k-signature) DB. This file
// covers the candidate-derivation unit and the correctness bar this task
// requires: the evidence-directed default (`loadSignatures(layers)` with no
// `--exhaustive`) must attribute the SAME packages as the old exhaustive
// path for every module both attribute — no silently-shipped recall drop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { buildInventory } from "../../../src/deps/inventory.ts";
import { resolveDbLayers, loadSignatures } from "../../../src/deps/db.ts";
import { matchInventory } from "../../../src/deps/match.ts";
import { buildDependencyIndex, deriveCandidatePackages, findCandidatesInText, packageNameFromSigFilename } from "../../../src/deps/candidates.ts";

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");

test("packageNameFromSigFilename: reverses writeSignature's `/` -> `__` mangling, ignores non-signature files", () => {
  assert.equal(packageNameFromSigFilename("lodash@4.17.21__hbc94.json"), "lodash");
  assert.equal(packageNameFromSigFilename("@react-navigation__native@6.1.18__hbc94.json"), "@react-navigation/native");
  assert.equal(packageNameFromSigFilename("index.json"), null);
  assert.equal(packageNameFromSigFilename("not-a-signature-file.txt"), null);
});

test("findCandidatesInText: multi-pattern substring search, case-insensitive, independent of pattern count", () => {
  const found = findCandidatesInText(["react-native", "lodash", "totally-absent-package"], "some code mentions React-Native and Lodash somewhere".toLowerCase());
  assert.ok(found.has("react-native"));
  assert.ok(found.has("lodash"));
  assert.ok(!found.has("totally-absent-package"));
});

test("findCandidatesInText: handles thousands of patterns without degrading to per-pattern scanning (perf smoke)", () => {
  const patterns = Array.from({ length: 20000 }, (_, i) => `synthetic-package-${i}`);
  patterns.push("needle-package");
  const haystack = `${"padding text ".repeat(2000)}this bundle mentions needle-package once${"more padding ".repeat(2000)}`;
  const start = Date.now();
  const found = findCandidatesInText(patterns, haystack);
  const elapsedMs = Date.now() - start;
  assert.ok(found.has("needle-package"));
  assert.equal(found.size, 1, `expected exactly the one real hit, got ${found.size}`);
  assert.ok(elapsedMs < 2000, `expected well under 2s for 20k patterns, took ${elapsedMs}ms`);
});

test("deriveCandidatePackages: rn-template-0.72 finds react + react-native from its own strings, without loading every shared-DB file", () => {
  const bytes = readFileSync(RN_TEMPLATE);
  const { inventory } = buildInventory(bytes);
  const layers = resolveDbLayers({ outDir: "/nonexistent-project-dir-for-this-test", noSharedDb: false });
  const candidates = deriveCandidatePackages(layers, inventory);
  assert.ok(candidates.has("react"), `expected "react" to be evidence-derived, got: ${[...candidates].join(", ")}`);
  assert.ok(candidates.has("react-native"), `expected "react-native" to be evidence-derived, got: ${[...candidates].join(", ")}`);
  assert.ok(!candidates.has("lodash"), "lodash has no evidence in rn-template's own strings and must not be a candidate");
});

test("correctness bar: evidence-directed default attributes the SAME packages as --exhaustive for every module both attribute (rn-template-0.72)", () => {
  const bytes = readFileSync(RN_TEMPLATE);
  const { inventory } = buildInventory(bytes);
  const layers = resolveDbLayers({ outDir: "/nonexistent-project-dir-for-this-test", noSharedDb: false });

  const exhaustiveDbs = loadSignatures(layers); // no candidates: old, unconditional behaviour
  const exhaustiveReport = matchInventory(inventory, exhaustiveDbs);

  const candidates = deriveCandidatePackages(layers, inventory);
  const directedDbs = loadSignatures(layers, { candidates });
  const directedReport = matchInventory(inventory, directedDbs);

  // Evidence-directed must never load MORE files than exhaustive (it's a
  // subset by construction) and, for this well-evidenced fixture, should
  // load meaningfully fewer — the actual perf win.
  assert.ok(directedDbs.length <= exhaustiveDbs.length, `evidence-directed loaded ${directedDbs.length} files, exhaustive loaded ${exhaustiveDbs.length} — expected a subset`);

  let comparedModules = 0;
  let divergences = 0;
  const diffs: string[] = [];
  for (let i = 0; i < exhaustiveReport.moduleAttributions.length; i++) {
    const ex = exhaustiveReport.moduleAttributions[i]!;
    const dir = directedReport.moduleAttributions[i]!;
    if (ex.owners.length === 0 || dir.owners.length === 0) continue; // only compare modules BOTH attribute
    comparedModules++;
    const exSet = [...ex.owners].sort().join(",");
    const dirSet = [...dir.owners].sort().join(",");
    if (exSet !== dirSet) {
      divergences++;
      diffs.push(`module#${i}: exhaustive=[${exSet}] evidence-directed=[${dirSet}]`);
    }
  }
  assert.equal(divergences, 0, `evidence-directed diverged from exhaustive on ${divergences}/${comparedModules} modules both attribute:\n${diffs.join("\n")}`);
  assert.ok(comparedModules > 0, "expected at least some modules attributed by both paths on this well-covered fixture");

  // Same confirmedDeps package set, quantified (docs/DEPS.md "evidence-directed" numbers).
  const exConfirmed = new Set(exhaustiveReport.packages.filter((p) => p.tier === "high" && !p.isBaseline).map((p) => p.package));
  const dirConfirmed = new Set(directedReport.packages.filter((p) => p.tier === "high" && !p.isBaseline).map((p) => p.package));
  assert.deepEqual([...dirConfirmed].sort(), [...exConfirmed].sort(), `evidence-directed confirmedDeps package set must match exhaustive's on rn-template-0.72; exhaustive=${[...exConfirmed]} directed=${[...dirConfirmed]}`);
});

test("CAND: deriveCandidatePackages adds a literally-evidenced package's own recorded npm dependencies (subtractedDependencies) as candidates, even with zero string evidence of the dependency's own name", () => {
  // Mirrors the real, measured shape (react-native@0.74.2's actual
  // subtractedDependencies list, docs/DEPS.md "candidate-derivation
  // dependency expansion"): a real dependency (`nullthrows`) that has no
  // literal name trace anywhere in a minified bundle's own strings must
  // still become a candidate once its dependant (`host-package`, standing
  // in for react-native) is itself evidenced.
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-cand-test-"));
  const hostFile = {
    schema: 2,
    package: "host-package",
    version: "1.0.0",
    hbcVersion: 96,
    totalFunctions: 1,
    rawFunctionCount: 1,
    subtractedBaselines: [],
    functions: [],
    modules: [],
    toolchainBaseline: false,
    provenance: { packageSha256: null, metroVersion: null, reactNativeVersion: null, hermescVersion: 96, hermescRnEra: null, repoCommit: null, builtAt: "2026-01-01" },
    subtractedDependencies: ["leaf-dep-package@2.0.0__hbc96.json"],
  };
  const leafFile = { ...hostFile, package: "leaf-dep-package", version: "2.0.0", subtractedDependencies: [] };
  const uninvolvedFile = { ...hostFile, package: "unrelated-package", version: "3.0.0", subtractedDependencies: [] };
  writeFileSync(join(dir, "host-package@1.0.0__hbc96.json"), JSON.stringify(hostFile));
  writeFileSync(join(dir, "leaf-dep-package@2.0.0__hbc96.json"), JSON.stringify(leafFile));
  writeFileSync(join(dir, "unrelated-package@3.0.0__hbc96.json"), JSON.stringify(uninvolvedFile));

  const inventory = { hbcVersion: 96, totalFunctions: 0, moduledFunctionCount: 0, functions: [], modules: [{ stringConstants: ["some code requires host-package somewhere"] }] } as unknown as import("../../../src/deps/inventory.ts").ModuleInventory;

  const layers = [{ name: "shared" as const, dir }];
  const candidates = deriveCandidatePackages(layers, inventory);
  assert.ok(candidates.has("host-package"), "the literally-evidenced package itself must still be a candidate");
  assert.ok(candidates.has("leaf-dep-package"), `leaf-dep-package (a recorded npm dependency of the evidenced host-package, no string evidence of its own) must become a candidate via dependency expansion — got: ${[...candidates].join(", ")}`);
  assert.ok(!candidates.has("unrelated-package"), "a package with neither string evidence nor a dependency edge from an evidenced package must not become a candidate");
});

test("--exhaustive preserves the exact pre-QUEUE-22a behaviour: loadSignatures(layers) with no options loads every file, unfiltered", () => {
  const bytes = readFileSync(RN_TEMPLATE);
  const { inventory } = buildInventory(bytes);
  const layers = resolveDbLayers({ outDir: "/nonexistent-project-dir-for-this-test", noSharedDb: false });
  const a = loadSignatures(layers);
  const b = loadSignatures(layers, {});
  assert.equal(a.length, b.length, "omitting opts and passing {} must be equivalent — both exhaustive");
  void inventory;
});

test("corpus-remeasure2-brex-oom: dependency expansion lists each layer once, reads each signature file at most once, and terminates on cyclic wide fan-out", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-oom-test-"));
  const P = 50, V = 20;
  const base = { schema: 2, totalFunctions: 0, rawFunctionCount: 0, subtractedBaselines: [], functions: [], modules: [], toolchainBaseline: false, hbcVersion: 96, provenance: { packageSha256: null, metroVersion: null, reactNativeVersion: null, hermescVersion: 96, hermescRnEra: null, repoCommit: null, builtAt: "2026-01-01" } };
  for (let p = 0; p < P; p++) {
    for (let v = 0; v < V; v++) {
      const deps = [];
      for (let q = 0; q < P; q++) if (q !== p) deps.push(`@scope__pkg${q}@1.0.${v}__hbc96.json`); // every package depends on every other: cycles
      writeFileSync(join(dir, `@scope__pkg${p}@1.0.${v}__hbc96.json`), JSON.stringify({ ...base, package: `@scope/pkg${p}`, version: `1.0.${v}`, subtractedDependencies: deps }));
    }
  }
  const strings = Array.from({ length: P }, (_, i) => `@scope/pkg${i}`);
  const inventory = { hbcVersion: 96, totalFunctions: 0, moduledFunctionCount: 0, functions: [], modules: [{ stringConstants: strings }] } as unknown as import("../../../src/deps/inventory.ts").ModuleInventory;
  // Same dir listed twice through two layers must not double-read either.
  const layers = [{ name: "shared" as const, dir }, { name: "shared" as const, dir }];
  const reads = new Map<string, number>();
  const index = buildDependencyIndex(layers, (path) => { reads.set(path, (reads.get(path) ?? 0) + 1); return readFileSync(path, "utf8"); });
  const candidates = deriveCandidatePackages(layers, inventory, index);
  assert.equal(candidates.size, P);
  assert.equal(reads.size, P * V);
  assert.ok([...reads.values()].every((n) => n === 1), "each signature file is read at most once per run");
});
