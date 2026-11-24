// The ladder (spec §7.3):
//   1. `renderModuleReadable` at the tier §7.2 selects for this module
//      (`jsx` only when the module is tagged `rendersJsx`, `passes`
//      otherwise) -- manifest tier `"jsx"`/`"passes"`, no downgrade reason.
//   2. On failure, the flat `--split` text for this module is already in
//      hand (the base `splitProject` call this module ran through to reach
//      here) -- manifest tier `"flat"`, `tierDowngradeReason` set.
//   3. When that flat text is itself `src/split/index.ts`'s own
//      empty-factory stub (the module's factory was never reachable from
//      the module graph, so there was never anything to render) --
//      manifest tier `"stub"` and one `unresolved` row, kind
//      `"no-readable-render"`.
// An explicit `--tier flat` request skips step 1 outright: it is not a
// downgrade, but the manifest schema still requires a non-null
// `tierDowngradeReason` for any non-`passes`/`jsx` tier (spec §6, enforced
// by `tests/gate/export/manifest.test.ts`), so the reason names the request
// instead of a failure.
import type { ModuleAnalysis } from "../cfg/types.ts";
import type { OverlayStore } from "../name-overlay/store.ts";
import { renderModuleReadable } from "../split/render-module.ts";
import type { SubtreeJob, SubtreeOptions, SubtreeResult } from "../emit/index.ts";
import type { ExportTier } from "./index.ts";

/** `src/split/index.ts`'s own marker text for a factory `decompileAllBodies`
 *  never reached -- the ONE reliably-detectable "there is nothing to render
 *  here" signal available from the flat text alone (no second bytecode walk
 *  needed to tell rung 2 from rung 3). */
const UNREACHABLE_FACTORY_MARKER = "was not reachable from the module graph";

export type RenderedTier = "passes" | "jsx" | "flat" | "stub";

export interface TieredModuleResult {
  /** The module's rendered body text -- for `"passes"`/`"jsx"`, `renderModuleReadable`'s
   *  output (still needs wrapping into the loader shape, `wrapReadableModule`); for
   *  `"flat"`/`"stub"`, the flat `--split` text unchanged (already loader-shaped). */
  readonly code: string;
  readonly tier: RenderedTier;
  readonly tierDowngradeReason: string | null;
  readonly unresolved?: { readonly kind: "no-readable-render"; readonly detail: string };
  /** Empty for `"flat"`/`"stub"` (no pass ladder ran). */
  readonly helpersUsed: readonly string[];
}

export interface RenderModuleTieredOptions {
  readonly analysis: ModuleAnalysis;
  readonly factoryFn: number | null;
  readonly moduleId: number;
  readonly requestedTier: ExportTier;
  readonly rendersJsx: boolean;
  readonly moduleName: string;
  /** The flat `--split` text for this module, from the base (no-passes)
   *  `splitProject` call every module in an export run goes through --
   *  rung 2/3's source, and step 1's own required input for detecting the
   *  step-3 stub marker. */
  readonly flatText: string;
  readonly store?: OverlayStore;
}

/** §7.2 point 1: under `--tier jsx`, only `rendersJsx` modules pay for the
 *  `jsx-recover` rung; everything else renders at `passes`. Under
 *  `--tier passes` every module targets `passes`.  `--tier flat` is handled
 *  by the caller (`renderModuleTiered` below) before this is consulted. */
function targetReadableTier(requestedTier: ExportTier, rendersJsx: boolean): "passes" | "jsx" {
  return requestedTier === "jsx" && rendersJsx ? "jsx" : "passes";
}

/** The readable-render attempt alone (rung 1), without the flat fallback:
 *  everything a render worker (`src/export/render-pool.ts`) needs to send
 *  back. `tieredFromOutcome` turns it into the module's final result. */
export type ReadableOutcome =
  | { readonly ok: true; readonly code: string; readonly tier: "passes" | "jsx"; readonly helpersUsed: readonly string[] }
  | { readonly ok: false; readonly reason: string };

export type ReadableRenderOptions = Omit<RenderModuleTieredOptions, "flatText">;

function readableRender(opts: ReadableRenderOptions, subtrees: SubtreeOptions | undefined): ReturnType<typeof renderModuleReadable> {
  const target = targetReadableTier(opts.requestedTier, opts.rendersJsx);
  return renderModuleReadable(opts.analysis, opts.factoryFn!, opts.moduleId, {
    tier: target,
    passes: target === "jsx" ? { optIn: ["jsx-recover"] } : {},
    strictEnv: false,
    moduleName: opts.moduleName,
    ...(opts.store !== undefined ? { store: opts.store } : {}),
    ...(subtrees !== undefined ? { subtrees } : {}),
  });
}

/** Rung 1's nested emissions, for rendering one large module across
 *  workers (spec 29 §12): every nested function for which `descend` is false
 *  becomes a job (`renderReadableSubtree`); `null` when the module cannot be
 *  split (no factory, or the walk itself failed -- render it whole). */
export function probeReadableSubtrees(opts: ReadableRenderOptions, descend: (fn: number) => boolean): readonly SubtreeJob[] | null {
  if (opts.factoryFn === null) return null;
  try {
    return readableRender(opts, { descend }).subtreeJobs ?? null;
  } catch {
    return null;
  }
}

/** One job of `probeReadableSubtrees`; `null` when it threw (the assembly
 *  then emits that function in place and fails or stubs exactly as the
 *  whole render would). */
export function renderReadableSubtree(opts: ReadableRenderOptions, job: SubtreeJob): SubtreeResult | null {
  try {
    return readableRender(opts, { root: job }).subtree ?? null;
  } catch {
    return null;
  }
}

/** Rung 1 for a non-`flat` requested tier. Never throws. With `subtrees`,
 *  nested emissions matching a result are spliced in (`emitModule`'s
 *  `subtrees.results`); the code is the same either way. */
export function renderReadableOutcome(opts: ReadableRenderOptions, subtrees?: SubtreeOptions): ReadableOutcome {
  const target = targetReadableTier(opts.requestedTier, opts.rendersJsx);
  if (opts.factoryFn === null) return { ok: false, reason: "module has no resolved factory function index" };
  try {
    const out = readableRender(opts, subtrees);
    return { ok: true, code: out.code, tier: target, helpersUsed: out.helpersUsed };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** §7.3's ladder below rung 1: a failed readable render falls back to the
 *  flat `--split` text (rung 2) or the empty-factory stub (rung 3). */
export function tieredFromOutcome(
  opts: Pick<RenderModuleTieredOptions, "moduleId" | "factoryFn" | "flatText">,
  outcome: ReadableOutcome,
): TieredModuleResult {
  if (outcome.ok) return { code: outcome.code, tier: outcome.tier, tierDowngradeReason: null, helpersUsed: outcome.helpersUsed };
  const reason = outcome.reason;
  if (opts.flatText.includes(UNREACHABLE_FACTORY_MARKER)) {
    return {
      code: opts.flatText,
      tier: "stub",
      tierDowngradeReason: `readable render not attempted (${reason}); factory unreachable from the module graph, wrote the empty-factory stub`,
      unresolved: {
        kind: "no-readable-render",
        detail: `module ${opts.moduleId}: ${reason}; factory fn#${opts.factoryFn ?? "?"} was not reachable from the module graph`,
      },
      helpersUsed: [],
    };
  }
  return {
    code: opts.flatText,
    tier: "flat",
    tierDowngradeReason: `readable render failed (${reason}); used the flat --split text instead`,
    helpersUsed: [],
  };
}

export function renderModuleTiered(opts: RenderModuleTieredOptions): TieredModuleResult {
  if (opts.requestedTier === "flat") {
    return {
      code: opts.flatText,
      tier: "flat",
      tierDowngradeReason: "requested tier is flat (--tier flat); no readable render was attempted",
      helpersUsed: [],
    };
  }
  return tieredFromOutcome(opts, renderReadableOutcome(opts));
}
