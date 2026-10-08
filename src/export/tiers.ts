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

export function renderModuleTiered(opts: RenderModuleTieredOptions): TieredModuleResult {
  if (opts.requestedTier === "flat") {
    return {
      code: opts.flatText,
      tier: "flat",
      tierDowngradeReason: "requested tier is flat (--tier flat); no readable render was attempted",
      helpersUsed: [],
    };
  }

  const target = targetReadableTier(opts.requestedTier, opts.rendersJsx);

  const fail = (reason: string): TieredModuleResult => {
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
  };

  if (opts.factoryFn === null) {
    return fail("module has no resolved factory function index");
  }

  try {
    const out = renderModuleReadable(opts.analysis, opts.factoryFn, opts.moduleId, {
      tier: target,
      passes: target === "jsx" ? { optIn: ["jsx-recover"] } : {},
      strictEnv: false,
      moduleName: opts.moduleName,
      ...(opts.store !== undefined ? { store: opts.store } : {}),
    });
    return { code: out.code, tier: target, tierDowngradeReason: null, helpersUsed: out.helpersUsed };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}
