// src/export/manifest.ts — docs/specs/29-export.md §6: `EXPORT.json`. One
// function, `buildExportManifest`, so `src/export/index.ts` never hand-rolls
// the schema and the coverage invariant (§6's own words: "the one assertion
// the whole design rests on") is checked HERE, as a real assertion that
// throws, not only in `tests/gate/export/manifest.test.ts` -- a caller that
// drops or double-counts a module id finds out before it ever writes a tree,
// not only when a gate test happens to run.
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import type { ExportTier } from "./index.ts";
import type { RenderedTier } from "./tiers.ts";

export interface ExportManifestModule {
  readonly id: number;
  readonly path: string;
  readonly bucket: string;
  readonly tier: RenderedTier;
  readonly tierDowngradeReason: string | null;
  readonly rendersJsx: boolean;
  readonly owner: string | null;
  readonly eagerDeps: number;
  readonly lazyDeps: number;
}

export interface ExportManifestSubstitution {
  readonly package: string;
  readonly version: string;
  readonly confidence: number;
  readonly boundaryModule: number;
  readonly replacedModules: readonly number[];
  readonly edgesRewritten: number;
  readonly forms: { readonly eager: number; readonly lazy: number };
}

export interface ExportManifestUnresolved {
  readonly kind: string;
  readonly detail: string;
}

export interface BuildExportManifestOptions {
  readonly hbc2jsVersion: string;
  readonly gitSha: string | null;
  readonly tier: ExportTier;
  readonly substitute: "none" | "safe";
  readonly namesOverlay: string | null;
  readonly bundleSha256: string;
  readonly bytes: number;
  readonly hbcVersion: number;
  readonly moduleCount: number;
  readonly entryModule: number | null;
  readonly appName: string;
  readonly appNameSource: string;
  readonly reactNative: { readonly version: string | null; readonly source: string; readonly consistentWithHbc: boolean | null; readonly expectedRange: string | null };
  readonly dependencies: Readonly<Record<string, { readonly version: string; readonly kind: string; readonly source: string; readonly confidence: number | null }>>;
  readonly modules: readonly ExportManifestModule[];
  readonly substitutions: readonly ExportManifestSubstitution[];
  readonly unresolved: readonly ExportManifestUnresolved[];
  readonly leftOut: readonly string[];
}

const TIER_KEYS = ["passes", "flat", "jsx", "stub"] as const;

/** §6's manifest object, ready for `JSON.stringify`. Throws
 *  (`E_INTERNAL`, never a silently-wrong manifest) when the coverage
 *  invariant does not hold: every module id in `opts.modules` and the union
 *  of `opts.substitutions[].replacedModules` must appear exactly once
 *  between them, and that union's size must equal `opts.moduleCount`. */
export function buildExportManifest(opts: BuildExportManifestOptions): Record<string, unknown> {
  const kept = opts.modules.map((m) => m.id);
  const replaced = opts.substitutions.flatMap((s) => s.replacedModules);
  const all = [...kept, ...replaced];
  const keptSet = new Set(kept);
  if (new Set(all).size !== all.length) {
    throw new Hbc2jsError(ErrorCode.E_INTERNAL, "export: coverage invariant violated -- a module id is listed twice across modules[]/substitutions[].replacedModules", { section: "export/manifest" });
  }
  for (const id of replaced) {
    if (keptSet.has(id)) {
      throw new Hbc2jsError(ErrorCode.E_INTERNAL, `export: coverage invariant violated -- module ${id} is both kept and replaced by a substitution`, { section: "export/manifest" });
    }
  }
  if (all.length !== opts.moduleCount) {
    throw new Hbc2jsError(
      ErrorCode.E_INTERNAL,
      `export: coverage invariant violated -- modules[] (+substitutions) covers ${all.length} of ${opts.moduleCount} module id(s)`,
      { section: "export/manifest" },
    );
  }

  const bucketCount = (b: string): number => opts.modules.filter((m) => m.bucket === b).length;
  const tierTallies: Record<string, number> = { passes: 0, flat: 0, jsx: 0, stub: 0 };
  for (const m of opts.modules) tierTallies[m.tier] = (tierTallies[m.tier] ?? 0) + 1;

  const counts = {
    modules: opts.modules.length,
    app: bucketCount("app"),
    vendor: bucketCount("vendor"),
    unclassified: bucketCount("unclassified"),
    substitutedPackages: opts.substitutions.length,
    substitutedModules: opts.substitutions.reduce((n, s) => n + s.replacedModules.length, 0),
    tiers: { passes: tierTallies["passes"], flat: tierTallies["flat"], jsx: tierTallies["jsx"], stub: tierTallies["stub"] },
    unresolved: opts.unresolved.length,
  };
  // Every tier key spec §6 documents is present even when zero, so a reader
  // (or a test) never has to guess whether an absent key means zero or
  // "this hbc2js version didn't know about that tier".
  for (const k of TIER_KEYS) if (!(k in counts.tiers)) (counts.tiers as Record<string, number>)[k] = 0;

  return {
    schema: "hbc2js-export/1",
    producer: {
      hbc2js: opts.hbc2jsVersion,
      git: opts.gitSha,
      ts: new Date().toISOString(),
      options: { tier: opts.tier, substitute: opts.substitute, names: opts.namesOverlay },
    },
    source: {
      bundleSha256: opts.bundleSha256,
      bytes: opts.bytes,
      hbcVersion: opts.hbcVersion,
      moduleCount: opts.moduleCount,
      entryModule: opts.entryModule,
    },
    app: { name: opts.appName, nameSource: opts.appNameSource },
    reactNative: opts.reactNative,
    dependencies: opts.dependencies,
    modules: opts.modules,
    substitutions: opts.substitutions,
    unresolved: opts.unresolved,
    counts,
    leftOut: opts.leftOut,
  };
}
