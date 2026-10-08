import type { Diagnostic } from "../errors.ts";
import type { ModuleAnalysis } from "../cfg/types.ts";
import { emitModule } from "../emit/index.ts";
import type { Stmt } from "../emit/ast.ts";
import { astPassHook, passHook } from "../passes/index.ts";
import type { PassPipelineOptions } from "../passes/index.ts";
import { applyOverlayNames } from "../name-overlay/render.ts";
import type { OverlayStore } from "../name-overlay/store.ts";
import { annotateDependencyReads } from "./dep-annotate.ts";

/** `passes`: the ordinary pass ladder (readable output). `jsx`: the same
 *  ladder plus the opt-in `jsx-recover` pass and JSX print form (D20: JSX
 *  output is not runnable JS -- `node --check` is skipped for this tier by
 *  every caller). */
export type ReadableTier = "passes" | "jsx";

export interface RenderModuleOptions {
  readonly passes?: PassPipelineOptions;
  readonly strictEnv?: boolean;
  readonly tier: ReadableTier;
  /** Applied to every register the overlay has a name for, same composition
   *  `src/name-overlay/render.ts`'s whole-bundle `render()` uses (overlay
   *  before the ordinary stage-B passes) -- so a readable render never
   *  throws away a name the naming/readability layer already produced. */
  readonly store?: OverlayStore;
  readonly moduleName?: string;
  readonly dependencyAnnotations?: {
    readonly deps: readonly number[];
    readonly packageOf?: (moduleId: number) => string | undefined;
  };
}

export interface RenderModuleResult {
  readonly code: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly decompileDiagnostics: number;
  /** `EmitResult.helpersUsed` for exactly this module's own scoped render
   *  (EM-03) — export (`src/export/index.ts`, spec 29 §4.4) unions this
   *  across every module it renders through this function to build the
   *  shared `src/_hbc/helpers.js`, since there is no longer one whole-bundle
   *  `emitModule` call to read a single `helpersUsed` off. */
  readonly helpersUsed: readonly string[];
}

function tierLabel(opts: RenderModuleOptions): string {
  const base = opts.tier === "jsx" ? "passes+jsx" : "passes";
  return opts.store !== undefined ? `${base}+names` : base;
}

/** Renders `factoryFn` (a module's factory, as `ModuleEntry.factoryFn`/
 *  `SplitModuleInfo.factoryFunctionIndex`) plus its whole hosted closure
 *  subtree, scoped (`emitModule`'s `onlyFunction`), with the overlay applied
 *  when `opts.store` is given. The header states the tier and module id so a
 *  reader (or a test) never has to guess which pass ladder produced the file. */
export function renderModuleReadable(analysis: ModuleAnalysis, factoryFn: number, moduleId: number, opts: RenderModuleOptions): RenderModuleResult {
  const strictEnv = opts.strictEnv ?? false;
  const realHook = astPassHook(analysis, opts.passes);
  const namedHook =
    opts.store === undefined
      ? realHook
      : (fn: Stmt, cfg: Parameters<typeof realHook>[1]): { readonly fn: Stmt; readonly diagnostics: readonly Diagnostic[] } => {
          if (fn.k !== "func") return realHook(fn, cfg);
          const applied = applyOverlayNames(cfg.functionIndex, fn.body, opts.store!.activeNamesForFn(cfg.functionIndex));
          return realHook({ ...fn, body: applied.body }, cfg);
        };
  // H1: only the factory's own top-level render (cfg.functionIndex ===
  // factoryFn) has a dependencyMap parameter -- a hosted closure this
  // module nests never does, so it is never passed through
  // annotateDependencyReads at all.
  const astPasses =
    opts.dependencyAnnotations === undefined
      ? namedHook
      : (fn: Stmt, cfg: Parameters<typeof realHook>[1]): { readonly fn: Stmt; readonly diagnostics: readonly Diagnostic[] } => {
          const base = namedHook(fn, cfg);
          if (base.fn.k !== "func" || cfg.functionIndex !== factoryFn) return base;
          const { deps, packageOf } = opts.dependencyAnnotations!;
          const { body, annotated } = annotateDependencyReads(base.fn.body, base.fn.params.map((p) => p.name), deps, packageOf);
          return annotated === 0 ? base : { fn: { ...base.fn, body }, diagnostics: base.diagnostics };
        };
  const result = emitModule(analysis, {
    moduleName: opts.moduleName ?? "input.hbc",
    provenanceComments: false,
    strictEnv,
    passes: passHook(analysis, opts.passes),
    astPasses,
    onlyFunction: factoryFn,
    ...(opts.tier === "jsx" ? { jsx: true } : {}),
  });
  const header =
    `// hbc2js readable render -- module ${moduleId} (factory fn#${factoryFn}), tier: ${tierLabel(opts)}\n` +
    `// nested closures this module hosts are placed inside it exactly as the whole-bundle render would.\n`;
  return { code: header + result.code, diagnostics: result.diagnostics, decompileDiagnostics: result.stubbedFunctions, helpersUsed: result.helpersUsed };
}
