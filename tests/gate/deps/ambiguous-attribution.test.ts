// G4c (2026-09-28) supersedes G4b's own threshold: `AMBIGUOUS_OWNER_THRESHOLD`
// (20) never fired on either real fixture, so the original six rn-template
// react/react-native modules were still substituted blind. `ambiguousOwnerHash`
// is now a SET-IDENTITY check (every claimant is the same package, any
// version of it counts as that package) instead of a `>=20` threshold --
// see `src/deps/match.ts`'s own doc comment on the field for why this does
// not repeat e7c83bfa's mistake (that gate refused `owners`/`ownerBasis`
// itself, at the `match.ts` level, changing `moduleOwnership` membership;
// this flag still never does that -- only `own(P)` acts on it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchInventory, AMBIGUOUS_OWNER_THRESHOLD } from "../../../src/deps/match.ts";
import { buildReport } from "../../../src/deps/report.ts";
import type { ModuleInventory } from "../../../src/deps/inventory.ts";
import type { LoadedSig } from "../../../src/deps/db.ts";
import type { SigDbFile } from "../../../src/deps/sigdb-types.ts";

const SHARED_HASH = "shared-boilerplate-exact-hash-0001";

function fixtureSig(pkg: string, version: string = "1.0.0"): SigDbFile {
  return {
    schema: 2,
    package: pkg,
    version,
    hbcVersion: 96,
    totalFunctions: 1,
    rawFunctionCount: 1,
    subtractedBaselines: [],
    functions: [
      { index: 0, name: "factory", paramCount: 3, instrCount: 12, exactHash: SHARED_HASH, fuzzyHash: `fuzzy-${pkg}`, stringSetHash: `strings-${pkg}`, stringCount: 0 },
    ],
    modules: [
      { factoryFunctionIndex: 0, localModuleId: 0, depCount: 0, depIds: [], factoryExactHash: SHARED_HASH, factoryFuzzyHash: `fuzzy-${pkg}`, nestedFunctionCount: 0, functionSetHash: `fnset-${pkg}`, factoryIsBaseline: false },
    ],
    toolchainBaseline: false,
    provenance: { packageSha256: null, metroVersion: null, reactNativeVersion: null, hermescVersion: 96, hermescRnEra: null, repoCommit: null, builtAt: "2026-01-01T00:00:00.000Z" },
  };
}

function loadedSig(pkg: string, version: string = "1.0.0"): LoadedSig {
  return { file: fixtureSig(pkg, version), layer: "shared", path: `/fixture/${pkg}@${version}.json` };
}

// The target bundle's own module inventory: one module whose factory hash
// is the shared boilerplate hash and nothing else.
function ambiguousTargetInventory(): ModuleInventory {
  return {
    hbcVersion: 96,
    totalFunctions: 1,
    moduledFunctionCount: 1,
    modules: [
      {
        factoryFunctionIndex: 0,
        localModuleId: 42,
        depCount: 0,
        depIds: [],
        nestedFunctionIndices: [],
        functionIndices: [0],
        instrCount: 12,
        stringConstants: [],
        exactHash: SHARED_HASH,
        fuzzyHash: "target-fuzzy-does-not-match-either-fixture",
        stringSetHash: "target-string-set",
        factoryStringSetHash: "target-factory-string-set",
        factoryStringCount: 0,
        factoryOnly: true,
        fuzzyHashSet: "target-fuzzy-set",
        nestedExactHashSet: null,
        nestedFuzzyHashSet: null,
        nestedStringConstants: [],
      },
    ],
    functions: [
      { index: 0, name: "factory", paramCount: 3, instrCount: 12, exactHash: SHARED_HASH, fuzzyHash: "target-fuzzy-does-not-match-either-fixture", stringSetHash: "target-string-set", stringCount: 0 },
    ],
  };
}

test("match: a hash shared by two distinct packages is still attributed blindly (owners[0] pick preserved) but IS flagged ambiguousOwnerHash (G4c: set-identity, not a >=20 threshold)", () => {
  const dbs = [loadedSig("ambiguous-fixture-pkg-a"), loadedSig("ambiguous-fixture-pkg-b")];
  const matchReport = matchInventory(ambiguousTargetInventory(), dbs);

  const attribution = matchReport.moduleAttributions.find((m) => m.localModuleId === 42);
  assert.ok(attribution !== undefined);
  assert.equal(attribution!.owners.length, 2, "module 42 must be attributed to every claimant (blind owners[0] pick downstream), not refused");
  assert.equal(attribution!.ownerBasis, "exact");
  assert.equal(attribution!.ambiguousOwnerHash, true, "2 distinct PACKAGE NAMES claim this hash -- own(P) must refuse this module for either package");

  const report = buildReport("fixture.hbc", matchReport, []);
  const owned = report.moduleOwnership.find((o) => o.localModuleId === 42);
  assert.ok(owned !== undefined, "moduleOwnership must still name an owner for module 42 (membership unchanged -- only own(P) acts on the flag)");
  assert.equal(owned!.ambiguousOwnerHash, true);
});

test(`match: a hash shared by >= AMBIGUOUS_OWNER_THRESHOLD (${AMBIGUOUS_OWNER_THRESHOLD}) distinct packages is still attributed but flagged ambiguousOwnerHash (many claimants is a special case of "more than one")`, () => {
  // Not routed through buildReport here: with ONLY this one shared-hash
  // module as evidence, none of the 20 fixture packages reaches "high" tier
  // in the first place (scorePackage's own isUnambiguous already zeroes out
  // this hash's contribution to every package's score at exactly this
  // threshold) -- so confirmedDeps/moduleOwnership are correctly empty
  // regardless of this flag, by PRE-EXISTING package-level logic this task
  // does not touch. What this test isolates is `match.ts`'s per-module
  // attribution itself: it must still be a blind pick, never refused,
  // merely flagged. `AMBIGUOUS_OWNER_THRESHOLD` is not this flag's own
  // gate any more (G4c) -- it is reused here only as a convenient "many
  // distinct packages" fixture size, still exercising the same ">1" rule.
  const dbs = Array.from({ length: AMBIGUOUS_OWNER_THRESHOLD }, (_, i) => loadedSig(`ambiguous-fixture-pkg-${i}`));
  const matchReport = matchInventory(ambiguousTargetInventory(), dbs);

  const attribution = matchReport.moduleAttributions.find((m) => m.localModuleId === 42);
  assert.ok(attribution !== undefined);
  assert.equal(attribution!.owners.length, AMBIGUOUS_OWNER_THRESHOLD, "still a blind pick over every claimant, never refused");
  assert.equal(attribution!.ownerBasis, "exact");
  assert.equal(attribution!.ambiguousOwnerHash, true);
});

test("match: a hash shared by SEVERAL VERSIONS of the SAME package is NOT ambiguous -- set-identity, not a raw claimant count (a bare `owners.length > 1` would wrongly flag this)", () => {
  const dbs = [loadedSig("ambiguous-fixture-pkg-a", "1.0.0"), loadedSig("ambiguous-fixture-pkg-a", "2.0.0"), loadedSig("ambiguous-fixture-pkg-a", "3.0.0")];
  const matchReport = matchInventory(ambiguousTargetInventory(), dbs);

  const attribution = matchReport.moduleAttributions.find((m) => m.localModuleId === 42);
  assert.ok(attribution !== undefined);
  assert.equal(attribution!.owners.length, 3, "one claimant entry per package@version -- three raw claimants");
  assert.equal(attribution!.ownerBasis, "exact");
  assert.equal(attribution!.ambiguousOwnerHash, false, "every claimant is the SAME package (just different versions) -- own(P) must still accept and substitute this module");

  const report = buildReport("fixture.hbc", matchReport, []);
  const owned = report.moduleOwnership.find((o) => o.localModuleId === 42);
  assert.ok(owned !== undefined);
  assert.equal(owned!.ambiguousOwnerHash, false);
});
