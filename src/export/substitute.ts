// src/export/substitute.ts — docs/specs/29-export.md §5: library substitution,
// the S1-S4 boundary analysis. `planSubstitutions` is the one function this
// module exposes: it reads `DepsReport.moduleOwnership` and
// `index/modules.json`'s `DepEdge[]` graph (already in hand -- the same
// `ModuleEntry[]` `src/export/index.ts` builds via `buildIndexRows` for
// `rendersJsx`/eager-lazy counts, no second analysis) and decides, per
// package, substitute or refuse. Never touches a file: `src/export/index.ts`
// turns this plan into skipped modules + a registry redirect
// (`src/export/registry.ts`) + rewritten trailing registrations
// (`src/export/rewrite.ts`).
import type { DepsReport } from "../deps/report.ts";
import type { ConfidenceTier } from "../deps/match.ts";
import type { DepEdge } from "../artifact/schema.ts";
import type { ExportManifestSubstitution, ExportManifestUnresolved } from "./manifest.ts";

export type SubstituteMode = "none" | "safe";

/** §5.2 S1's threshold. `ConfirmedDep.confidence` is a `ConfidenceTier`
 *  string (`docs/DEPS.md`: only High-tier, non-baseline matches are ever
 *  reported as `confirmedDeps` -- see `src/deps/report.ts`), not the numeric
 *  score the spec's prose describes; this maps the tier to the score S1 was
 *  written against so the 0.8 floor stays a real, checked number rather than
 *  a tier-name comparison that would silently drift if the tier set ever
 *  grows finer. */
const TIER_SCORE: Record<ConfidenceTier, number> = { high: 0.95, medium: 0.6, low: 0.3, none: 0 };
export function tierConfidenceScore(tier: ConfidenceTier): number {
  return TIER_SCORE[tier];
}

export const SUBSTITUTION_CONFIDENCE_FLOOR = 0.8;

export interface SubstitutableModule {
  readonly id: number;
  readonly deps: readonly DepEdge[];
}

export interface SubstitutionPlan {
  readonly substitutions: readonly ExportManifestSubstitution[];
  readonly unresolved: readonly ExportManifestUnresolved[];
  /** Module id -> owning package, for every module id deleted from the tree
   *  (§5.2: "every file in own(P) is deleted"). Disjoint from any kept
   *  module id by construction (each package's `own(P)` is only added once
   *  it substitutes). */
  readonly replacedModules: ReadonlyMap<number, string>;
  /** Boundary module id -> package name, one entry per substituted package
   *  (§5.2 S2 guarantees exactly one). `src/export/registry.ts`'s `__hbc.r`
   *  redirect and `src/export/rewrite.ts`'s trailing registrations both key
   *  off this. */
  readonly boundaryPackage: ReadonlyMap<number, string>;
}

const EMPTY_PLAN: SubstitutionPlan = {
  substitutions: [],
  unresolved: [],
  replacedModules: new Map(),
  boundaryPackage: new Map(),
};

/** §5.2's S1-S4 boundary analysis, run once over the whole module graph.
 *  `mode: "none"` returns the empty plan unconditionally -- §5.3's escape
 *  hatch, asserted by `tests/gate/export/substitutions.test.ts`'s
 *  `--substitute none` case. */
export function planSubstitutions(
  report: DepsReport,
  modules: readonly SubstitutableModule[],
  mode: SubstituteMode,
): SubstitutionPlan {
  if (mode === "none") return EMPTY_PLAN;

  // own(P): module ids `moduleOwnership` attributes to each package. A
  // module with `localModuleId === null` was never resolved to a real Metro
  // id (ModuleOwnership's own contract) and cannot be a substitution target.
  // `own(P)` itself is the FULL blind-pick set here -- unlike G4b/G4c, a
  // module flagged `ambiguousOwnerHash` is NOT pre-excluded from membership.
  const ownByPkg = new Map<string, Set<number>>();
  // Every ambiguous member of each package's own(P), collected purely for
  // TRANSPARENCY (the unconditional reporting loop near the end of this
  // function) -- this list does not by itself gate membership; see above.
  const ambiguousByPkg = new Map<string, number[]>();
  const ambiguousModuleIds = new Set<number>();
  for (const m of report.moduleOwnership) {
    if (m.localModuleId === null) continue;
    let s = ownByPkg.get(m.package);
    if (s === undefined) {
      s = new Set();
      ownByPkg.set(m.package, s);
    }
    s.add(m.localModuleId);
    if (m.ambiguousOwnerHash) {
      ambiguousModuleIds.add(m.localModuleId);
      let list = ambiguousByPkg.get(m.package);
      if (list === undefined) {
        list = [];
        ambiguousByPkg.set(m.package, list);
      }
      list.push(m.localModuleId);
    }
  }

  const confirmedByPkg = new Map(report.confirmedDeps.map((d) => [d.package, d]));
  const rnVersionKnown = report.reactNativeVersion !== null;

  // Every (u -> v) edge in the whole graph, built once.
  const edges: { readonly u: number; readonly v: number; readonly kind: DepEdge["kind"] }[] = [];
  for (const m of modules) for (const e of m.deps) edges.push({ u: m.id, v: e.id, kind: e.kind });

  // S1 + S4 candidates, ignoring S2/S3 for now -- this is the set S3's own
  // "owned by a substituted package" clause is checked against (§5.2): a
  // leak from one high-confidence confirmed package's own(P) into another's
  // is a real cross-package edge a bundler can produce (e.g. react-native
  // itself requiring react), not a leak into app code, so it must not sink
  // S3 for either package just because the OTHER one separately fails S2.
  const candidatePkgs = new Set<string>();
  for (const [pkg, own] of ownByPkg) {
    if (own.size === 0) continue;
    const confirmed = confirmedByPkg.get(pkg);
    if (confirmed === undefined) continue;
    if (tierConfidenceScore(confirmed.confidence) < SUBSTITUTION_CONFIDENCE_FLOOR) continue;
    if ((pkg === "react-native" || pkg === "react") && !rnVersionKnown) continue;
    candidatePkgs.add(pkg);
  }
  const ownedByAnyCandidate = new Set<number>();
  for (const pkg of candidatePkgs) for (const id of ownByPkg.get(pkg)!) ownedByAnyCandidate.add(id);

  const substitutions: ExportManifestSubstitution[] = [];
  const unresolved: ExportManifestUnresolved[] = [];
  const replacedModules = new Map<number, string>();
  const boundaryPackage = new Map<number, string>();

  // Deterministic order (package name) so a re-run never reorders manifest
  // rows for no reason.
  for (const pkg of [...ownByPkg.keys()].sort()) {
    const own = ownByPkg.get(pkg)!;
    if (own.size === 0) continue;
    const confirmed = confirmedByPkg.get(pkg);
    if (confirmed === undefined) continue; // no evidence this is even a real dependency; nothing to decide

    const score = tierConfidenceScore(confirmed.confidence);
    if (score < SUBSTITUTION_CONFIDENCE_FLOOR) {
      unresolved.push({
        kind: "low-confidence",
        detail: `${pkg}: confidence tier "${confirmed.confidence}" (score ${score}) is below the ${SUBSTITUTION_CONFIDENCE_FLOOR} floor (S1)`,
      });
      continue;
    }
    if ((pkg === "react-native" || pkg === "react") && !rnVersionKnown) {
      unresolved.push({
        kind: "framework-version-unknown",
        detail: `${pkg}: refusing to substitute the framework with no confirmed react-native version (S4)`,
      });
      continue;
    }

    const boundary = new Set<number>();
    for (const e of edges) if (own.has(e.v) && !own.has(e.u)) boundary.add(e.v);
    if (boundary.size !== 1) {
      unresolved.push({
        kind: "multi-entry-package",
        detail: `${pkg}: ${boundary.size} boundary module(s) (S2 requires exactly 1); sub-path unknown, staying vendored`,
      });
      continue;
    }
    const soleBoundaryModule = [...boundary][0]!;
    if (ambiguousModuleIds.has(soleBoundaryModule)) {
      // G4d: the ONE module require(P) would resolve to is itself claimed
      // by a genuinely different package too -- unlike an interior member,
      // picking wrong here is observable (it misdirects require(P) itself),
      // so refuse the whole package rather than delete on a coin flip. The
      // unconditional `ambiguousByPkg` reporting loop below already names
      // this module (and any other ambiguous member of own(P)) -- no
      // separate row here to avoid double-reporting the same package.
      continue;
    }

    const leaks = edges.filter((e) => own.has(e.u) && !own.has(e.v) && !ownedByAnyCandidate.has(e.v));
    if (leaks.length > 0) {
      unresolved.push({
        kind: "not-closed",
        detail: `${pkg}: ${leaks.length} edge(s) leave own(${pkg}) to a module outside it and outside every other candidate package (S3)`,
      });
      continue;
    }

    const boundaryModule = [...boundary][0]!;
    const boundaryEdges = edges.filter((e) => e.v === boundaryModule);
    const eager = boundaryEdges.filter((e) => e.kind === "eager").length;
    const lazy = boundaryEdges.filter((e) => e.kind === "lazy").length;

    substitutions.push({
      package: pkg,
      version: confirmed.version,
      confidence: score,
      boundaryModule,
      replacedModules: [...own].sort((a, b) => a - b),
      edgesRewritten: boundaryEdges.length,
      forms: { eager, lazy },
    });
    for (const id of own) replacedModules.set(id, pkg);
    boundaryPackage.set(boundaryModule, pkg);
  }

  // One informational row per package that had ANY ambiguous member,
  // regardless of whether that member was the boundary (blocked the whole
  // package above) or interior (substituted safely alongside the rest) or
  // the package refused/substituted for a completely unrelated reason --
  // the collision is real either way and must be visible, never silently
  // dropped, same spirit as every other `unresolved` reason. This is
  // deliberately unconditional (not gated on the package's own S1-S4
  // outcome) so a package like `react-native` on rn-template-0.72, which
  // independently fails S2 for a real multi-entry reason unrelated to
  // ambiguity, still surfaces its six ambiguous modules here.
  for (const pkg of [...ambiguousByPkg.keys()].sort()) {
    const ids = ambiguousByPkg.get(pkg)!.sort((a, b) => a - b);
    unresolved.push({
      kind: "ambiguous-owner",
      detail: `${pkg}: ${ids.length} module(s) [${ids.join(", ")}] carry a factory hash also claimed by a different package -- excluded from own(${pkg}) (staying vendored) only when one of them is the package's own require("${pkg}") boundary; substituted safely alongside the rest of ${pkg} otherwise`,
    });
  }

  return { substitutions, unresolved, replacedModules, boundaryPackage };
}
