// tests/gate/export/substitute-ambiguous.test.ts — docs/specs/29-export.md
// §5 own(P) / docs/DEPS.md consumer-audit row. Rule history: G4b
// (2026-09-28) added the exclusion at the right LOCATION but the wrong RULE
// (reused `scorePackage`'s aggregate `AMBIGUOUS_OWNER_THRESHOLD`, measured
// INERT -- 0 modules flagged on either committed fixture). G4c fixed the
// RULE to a set-identity check (`ambiguousOwnerHash`, `src/deps/match.ts`)
// but OVERSHOT: it excluded every ambiguous module from own(P) regardless of
// whether the wrong pick could ever be observed, which flagged 525 of 1033
// modules on the held-out react-navigation-example app (mostly real
// `@react-navigation/*` code whose fingerprint collision with a sibling
// package is dependency-fingerprint contamination during signature harvest,
// not evidence the module is unsafe to delete -- `@react-navigation/stack`'s
// own signature legitimately contains `@react-navigation/native`'s code,
// per `tools/pkgsig/filter-unsubtracted.mjs`'s documented failure mode) and
// dropped `react-native-gesture-handler` from the held-out app's
// substituted-package count.
//
// G4d (2026-09-28, this landing) replaces the "exclude every ambiguous
// module from own(P)" rule with a narrower one: an EXACT factory-hash
// collision means the two candidates' bytes are byte-identical, so deleting
// an ambiguous INTERIOR module (nothing outside own(P) ever references it
// directly, by construction of "boundary", §5.2) changes nothing observable
// no matter which claimant truly wrote it. The only place a wrong pick is
// real is the package's own BOUNDARY module -- the one module
// `require(P)` gets rewritten to resolve to -- because picking wrong there
// misdirects the require itself. So `own(P)`'s *membership* is never gated
// on ambiguity; only the S2 boundary check is. Measured on both real
// fixtures (docs/DEPS.md's consumer-audit row) before landing this: on the
// held-out app, `react-native-gesture-handler`'s own(P) is a single module
// that is trivially its own boundary too, and its string constants
// (`@@asyncIterator`, `Generator`, `GeneratorFunction`, ...) show it is a
// generic Babel/regenerator-runtime helper shared with three structurally
// unrelated packages (`react-native-reanimated`, `react-native-worklets`,
// `@react-navigation/stack`) -- a genuinely earned refusal, not a false
// positive, so the held-out app's substituted-package count could not be
// safely restored above 1 on that fixture; every other ambiguous-flagged
// package there already fails S2 for a real, unrelated multi-entry reason,
// so this rule does not change their outcome either, only whether their
// (mostly interior) ambiguous modules are correctly reported as safe rather
// than falsely excluded.
//
// Fast unit tests directly against `planSubstitutions`, no CLI/bundle
// involved (mirrors tests/gate/deps/ambiguous-attribution.test.ts's own
// synthetic-fixture style) -- they fabricate `ambiguousOwnerHash` directly
// on `ModuleOwnership`, so they are unaffected by exactly how that flag
// gets computed upstream.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planSubstitutions } from "../../../src/export/substitute.ts";
import type { SubstitutableModule } from "../../../src/export/substitute.ts";
import type { DepsReport, ModuleOwnership } from "../../../src/deps/report.ts";

function ownership(over: Partial<ModuleOwnership> & { localModuleId: number; package: string }): ModuleOwnership {
  return { factoryFunctionIndex: over.localModuleId, version: "1.0.0", ambiguousOwnerHash: false, ...over };
}

/** Only the fields `planSubstitutions` actually reads (`moduleOwnership`,
 *  `confirmedDeps`, `reactNativeVersion`) are populated for real; the rest
 *  of `DepsReport`'s shape is irrelevant to this function, so this is cast
 *  rather than filled in field-by-field (same trade-off
 *  tests/security/t2-two-key-gate.test.ts's own fabricateReport makes, just
 *  narrower). */
function fabricateReport(moduleOwnership: readonly ModuleOwnership[], packages: readonly string[]): DepsReport {
  return {
    moduleOwnership,
    confirmedDeps: packages.map((p) => ({ package: p, version: "1.0.0", confidence: "high", modulesCovered: 3, moduleTotal: 3, source: "db-match" })),
    reactNativeVersion: null,
  } as unknown as DepsReport;
}

function modules(entries: readonly { id: number; deps: readonly { id: number; kind: "eager" | "lazy" }[] }[]): SubstitutableModule[] {
  return entries.map((e) => ({ id: e.id, deps: e.deps.map((d) => ({ ...d, site: null })) }));
}

test("own(P) substitutes an ambiguous INTERIOR module safely (identical bytes either way) while still reporting the collision", () => {
  // pkg-safe owns modules 10 (boundary), 11 (internal) -- clean S1-S4 pass --
  // plus module 12, attributed to pkg-safe too, flagged ambiguous, and with
  // no edges at all: nothing outside own(pkg-safe) ever references it, so a
  // wrong pick here is never observable.
  const report = fabricateReport(
    [
      ownership({ localModuleId: 10, package: "pkg-safe" }),
      ownership({ localModuleId: 11, package: "pkg-safe" }),
      ownership({ localModuleId: 12, package: "pkg-safe", ambiguousOwnerHash: true }),
    ],
    ["pkg-safe"],
  );
  const mods = modules([
    { id: 5, deps: [{ id: 10, kind: "eager" }] }, // outside app module -> boundary
    { id: 10, deps: [{ id: 11, kind: "eager" }] },
    { id: 11, deps: [] },
    { id: 12, deps: [] },
  ]);

  const plan = planSubstitutions(report, mods, "safe");

  const sub = plan.substitutions.find((s) => s.package === "pkg-safe");
  assert.ok(sub !== undefined, "pkg-safe should substitute -- module 12's ambiguity must not sink the whole package");
  assert.deepEqual(sub!.replacedModules, [10, 11, 12], "module 12 is interior (no edges) -- safe to delete alongside the rest, unlike G4c's blanket exclusion");
  assert.ok(plan.replacedModules.has(12), "module 12 must be deleted like any other interior module -- its bytes are identical regardless of which claimant is picked");

  const row = plan.unresolved.find((u) => u.kind === "ambiguous-owner" && u.detail.includes("pkg-safe"));
  assert.ok(row !== undefined, "the collision must still be visible in unresolved[], not silently dropped, even though it did not block anything");
  assert.ok(row!.detail.includes("12"), "the informational row should name the ambiguous module id");
});

test("own(P) substitutes an interior module ambiguous with a SIBLING-scoped package -- interchangeable collisions are not special-cased, only boundary-vs-interior is", () => {
  const report = fabricateReport(
    [
      ownership({ localModuleId: 30, package: "@family/a" }), // boundary
      ownership({ localModuleId: 31, package: "@family/a", ambiguousOwnerHash: true }), // interior, shared with @family/b
    ],
    ["@family/a"],
  );
  const mods = modules([
    { id: 9, deps: [{ id: 30, kind: "eager" }] },
    { id: 30, deps: [{ id: 31, kind: "eager" }] },
    { id: 31, deps: [] },
  ]);

  const plan = planSubstitutions(report, mods, "safe");

  const sub = plan.substitutions.find((s) => s.package === "@family/a");
  assert.ok(sub !== undefined, "@family/a should substitute despite the sibling collision");
  assert.deepEqual(sub!.replacedModules, [30, 31]);
});

test('own(P) refuses the whole package when its SOLE module is both the boundary and ambiguous (mirrors react-native-gesture-handler\'s real shape on the held-out app: a generic helper shared with an unrelated package)', () => {
  const report = fabricateReport(
    [ownership({ localModuleId: 20, package: "pkg-collision", ambiguousOwnerHash: true })],
    ["pkg-collision"],
  );
  const mods = modules([
    { id: 1, deps: [{ id: 20, kind: "eager" }] }, // outside app module -> makes 20 the sole boundary
    { id: 20, deps: [] },
  ]);

  const plan = planSubstitutions(report, mods, "safe");

  assert.equal(plan.substitutions.length, 0, "the package's only module is its own boundary and it is ambiguous -- nothing safe to substitute");
  assert.ok(!plan.replacedModules.has(20), "the boundary module must never be deleted on an unresolved pick");
  const row = plan.unresolved.find((u) => u.kind === "ambiguous-owner" && u.detail.includes("pkg-collision"));
  assert.ok(row !== undefined && row.detail.includes("20"), "the refusal must be visible in unresolved[]");
});
