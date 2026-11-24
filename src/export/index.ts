import { createHash } from "node:crypto";
import { progress, progressEnabled } from "../util/progress.ts";
import { Worker } from "node:worker_threads";
import { siblingWorkerPath } from "../util/worker-path.ts";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import { splitProject } from "../split/index.ts";
import { segregateSplitTree } from "../split/segregate.ts";
import { runDeps } from "../deps/index.ts";
import type { DepsReport } from "../deps/report.ts";
import { VERSION } from "../version.ts";
import { buildModulesIndexOnly } from "../artifact/index-rows.ts";
import { exportPathForModule } from "./layout.ts";
import type { ExportModuleInfo } from "./layout.ts";
import { buildHelpersJs, buildRegistryJs } from "./registry.ts";
import { rewriteModuleFile, wrapReadableModule } from "./rewrite.ts";
import { renderModuleTiered, tieredFromOutcome } from "./tiers.ts";
import type { ReadableOutcome, RenderedTier } from "./tiers.ts";
import { planRenderWorkers, renderModulesInPool, shareForRenderWorkers } from "./render-pool.ts";
import { resolveWorkerCount } from "../parallel/pool.ts";
import type { PoolStats, RenderJob } from "./render-pool.ts";
import { loadModuleSyntaxCheck, syntaxStubFlatText } from "./syntax-check.ts";
import type { ModuleSyntaxCheck } from "./syntax-check.ts";
import type { ExportManifestModule, ExportManifestUnresolved } from "./manifest.ts";
import { buildExportManifest } from "./manifest.ts";
import { planSubstitutions } from "./substitute.ts";
import type { SubstituteMode } from "./substitute.ts";
import {
  buildAppJson,
  buildBabelConfigJs,
  buildGitignore,
  buildIndexJs,
  buildMetroConfigJs,
  buildPackageJson,
  exportDependencies,
  recoverAppName,
  resolveReactNativeVersion,
} from "./boilerplate.ts";

export type ExportTier = "passes" | "flat" | "jsx";

export interface ExportOptions {
  /** §2 `--tier`: the per-module render tier CEILING. §7.2 selects, per
   *  module, `jsx` only for a module tagged `rendersJsx` (the rest render
   *  `passes` even under `--tier jsx`) -- `--tier flat` skips readable
   *  rendering outright and every module gets the flat `--split` text.
   *  Default `"passes"`. */
  readonly tier?: ExportTier;
  readonly appName?: string;
  readonly rnVersion?: string;
  /** §2 `--deps-report`: reuse a previous `hbc2js deps --json` report
   *  instead of re-running the deps stage. */
  readonly depsReport?: DepsReport;
  /** §5 / §2 `--substitute`: `"safe"` (default) runs the S1-S4 boundary
   *  analysis (`src/export/substitute.ts`) and substitutes every package
   *  that passes it; `"none"` is the §5.3 escape hatch -- every module stays
   *  vendored, byte-for-byte the 6a/6b tree. */
  readonly substitute?: SubstituteMode;
  readonly instrument?: "modules";
  /** Test hook only: replaces the per-module syntax check (default: parse
   *  with `@babel/parser`, `src/export/syntax-check.ts`). */
  readonly syntaxCheck?: ModuleSyntaxCheck;
  /** Render worker threads (`HBC2JS_WORKERS`, default `max(1, cpus - 2)`;
   *  see `resolveWorkerCount`). `1` renders serially on the main thread.
   *  The tree is byte-identical for every value. */
  readonly workers?: number;
}

export interface ExportResult {
  readonly files: ReadonlyMap<string, string>;
  readonly manifest: Record<string, unknown>;
}

/** `report` settles with the deps report; `online` once the worker thread is
 *  running -- the caller awaits it before its own long synchronous split, or
 *  the worker would not start until the split yields. */
function runDepsOnWorker(bundlePath: string): { readonly report: Promise<DepsReport>; readonly online: Promise<void> } {
  const w = new Worker(siblingWorkerPath("deps-worker", import.meta.url), { workerData: { bundlePath, progress: progressEnabled() } });
  const online = new Promise<void>((resolve) => {
    w.once("online", () => resolve());
    w.once("exit", () => resolve());
  });
  const report = new Promise<DepsReport>((resolve, reject) => {
    let settled = false;
    w.once("message", (msg: { ok: true; report: DepsReport } | { ok: false; message: string; code?: string }) => {
      settled = true;
      if (msg.ok) resolve(msg.report);
      else if (msg.code !== undefined && (Object.values(ErrorCode) as string[]).includes(msg.code)) {
        // Same class and exit code as an in-process failure; the message is
        // already formatted by the worker's Hbc2jsError.
        const e = new Hbc2jsError(msg.code as ErrorCode, "");
        e.message = msg.message;
        reject(e);
      } else reject(new Error(msg.message));
      void w.terminate();
    });
    w.once("error", (e) => {
      if (!settled) (settled = true), reject(e);
    });
    w.once("exit", (code) => {
      if (!settled) (settled = true), reject(new Error(`hbc2js export: deps worker exited with code ${code}`));
    });
  });
  return { report, online };
}

/** `hbc2js export <bundle.hbc> --out <dir>` (spec 29 §2-§4). Builds the
 *  whole file map in memory; write it with `writeExportResult`. */
export async function exportProject(bundlePath: string, opts: ExportOptions = {}): Promise<ExportResult> {
  progress(`reading ${bundlePath}`);
  const bytes = readFileSync(bundlePath);
  const moduleName = basename(bundlePath);
  const tier = opts.tier ?? "passes";
  const syntaxCheck = opts.syntaxCheck ?? (await loadModuleSyntaxCheck());

  // Always the flat (no-passes) split: the ONE whole-bundle parse+analysis
  // this run pays for (§1's pipeline diagram), and every module's flat text
  // is exactly §7.3's rung-2/rung-3 source. Per-module readable rendering
  // (rung 1, `passes`/`jsx`) runs off `splitResult.analysis` below, scoped
  // per module (`renderModuleTiered` -> `renderModuleReadable`, lane item 4)
  // instead of one whole-bundle pass-ladder emit -- so one bad function's
  // pass-ladder failure downgrades ONLY that module, never the whole run.
  // With more than one thread available the offline deps stage runs on a
  // worker, overlapping the split (it re-reads the bundle itself).
  const depsInWorker = opts.depsReport === undefined && resolveWorkerCount(opts.workers) > 1 ? runDepsOnWorker(bundlePath) : undefined;
  depsInWorker?.report.catch(() => undefined); // awaited below; never an unhandled rejection meanwhile
  if (depsInWorker !== undefined) await depsInWorker.online;
  progress("splitting the bundle into modules (decompiling every function)");
  const splitResult = splitProject(new Uint8Array(bytes), { moduleName });

  // The deps stage never touches the network from inside `export` — same
  // "no real model / no network in a gate run" rule every other lane
  // observes; `--deps-report` is the escape hatch for a caller that already
  // has a `--confirm`ed report. This is a second, cheap bytecode-inventory
  // scan (`buildInventory`), not a second full decompile — `splitProject`
  // above remains the one expensive parse.
  progress(`split: ${splitResult.modules.length} modules; ${opts.depsReport !== undefined ? "using the supplied deps report" : depsInWorker !== undefined ? "waiting for deps (offline, running alongside the split)" : "running deps (offline)"}`);
  const report: DepsReport = opts.depsReport ?? (depsInWorker !== undefined ? await depsInWorker.report : (await runDeps(bundlePath, { offline: true })).report);

  // §7.1/§7.2's own inputs (`DepEdge[]`, `rendersJsx`) -- reuses
  // `splitResult.module`/`.analysis` (`analyseForArtifact`), no second parse.
  const modulesIndex = buildModulesIndexOnly({ bytes, splitResult });
  const moduleIndexById = new Map(modulesIndex.modules.map((m) => [m.id, m]));

  // §5's S1-S4 boundary analysis, over the SAME `DepEdge[]` graph §7.1 built
  // -- no second analysis. `mode: "none"` (the §5.3 escape hatch) short-
  // circuits to the empty plan inside `planSubstitutions` itself.
  const substituteMode: SubstituteMode = opts.substitute ?? "safe";
  const plan = planSubstitutions(report, modulesIndex.modules, substituteMode);

  progress("segregating app code from dependencies");
  const segregated = segregateSplitTree(splitResult.files, report);
  const exportInfoById = new Map<number, ExportModuleInfo>();
  for (const info of segregated.modules) exportInfoById.set(info.id, exportPathForModule(info));
  const splitModuleById = new Map(splitResult.modules.map((m) => [m.id, m]));

  const pathOf = (id: number): string => {
    const info = exportInfoById.get(id);
    if (info === undefined) throw new Error(`export: module ${id} has no export path (segregate coverage gap)`);
    return info.path;
  };

  const files = new Map<string, string>();
  const modulesForManifest: ExportManifestModule[] = [];
  const unresolved: ExportManifestUnresolved[] = [];
  const helpersUsedAll = new Set<string>();

  // Rung 1 (the readable render) fanned out over worker threads when more
  // than one is available; everything else below stays serial, in module
  // order, consuming the outcomes by id -- so the tree does not depend on the
  // worker count.
  // The shared state is built (and the main thread's own caches dropped)
  // before planning, so the plan's memory budget sees the main thread as it
  // will stay during rendering.
  const poolWanted = tier !== "flat" && planRenderWorkers(opts.workers, splitResult.module.functions.length, bytes.length).count > 1;
  const shared = poolWanted ? shareForRenderWorkers(new Uint8Array(bytes), splitResult.analysis) : undefined;
  const workerPlan = shared === undefined ? { count: 1, limitedBy: null, budget: null, max: 1 } : planRenderWorkers(opts.workers, splitResult.module.functions.length, bytes.length);
  const workerCount = workerPlan.count;
  let pooled: Map<number, ReadableOutcome> | undefined;
  if (shared !== undefined) {
    const jobs: RenderJob[] = [];
    for (const info of segregated.modules) {
      if (plan.replacedModules.has(info.id)) continue;
      const idxEntry = moduleIndexById.get(info.id);
      jobs.push({
        factoryFn: idxEntry?.factoryFn ?? splitModuleById.get(info.id)?.factoryFunctionIndex ?? null,
        moduleId: info.id,
        requestedTier: tier,
        rendersJsx: idxEntry?.rendersJsx ?? false,
        moduleName,
        cost: splitResult.files.get(info.originalFile)?.length ?? 0,
      });
    }
    progress(`rendering ${jobs.length} modules on ${Math.min(workerCount, jobs.length)} worker thread(s)${workerPlan.limitedBy === "memory" ? " (capped by physical memory)" : ""}`);
    let reported = 0;
    const poolStats: PoolStats = { peakWorkers: 0, peakWorkerHeap: 0 };
    pooled = await renderModulesInPool(shared, jobs, workerPlan, (done) => {
      if (done - reported >= 250) {
        reported = done - (done % 250);
        progress(`rendering modules ${reported}/${jobs.length}`);
      }
    }, poolStats);
    progress(`render pool: at most ${poolStats.peakWorkers} worker(s) at once, largest worker heap ${Math.round(poolStats.peakWorkerHeap / 2 ** 20)} MB; main thread rss ${Math.round(process.memoryUsage().rss / 2 ** 20)} MB (process-wide)`);
  }

  let renderedCount = 0;
  for (const info of segregated.modules) {
    if (pooled === undefined && renderedCount % 250 === 0) progress(`rendering modules ${renderedCount}/${segregated.modules.length}`);
    renderedCount += 1;
    // §5.2: "every file in own(P) is deleted from the tree" -- this module's
    // id is covered instead by `substitutions[].replacedModules` (below),
    // never written and never double-counted (manifest.ts's own coverage
    // invariant checks exactly this).
    if (plan.replacedModules.has(info.id)) continue;
    const exportInfo = exportInfoById.get(info.id)!;
    const originalText = splitResult.files.get(info.originalFile);
    if (originalText === undefined) throw new Error(`export: split tree has no file for module ${info.id} (${info.originalFile})`);
    const splitModule = splitModuleById.get(info.id);
    const idxEntry = moduleIndexById.get(info.id);
    const rendersJsxTag = idxEntry?.rendersJsx ?? false;
    const depEdges = idxEntry?.deps ?? [];
    const eagerDeps = depEdges.filter((d) => d.kind === "eager").length;
    const lazyDeps = depEdges.filter((d) => d.kind === "lazy").length;
    const depIds = depEdges.length > 0 ? depEdges.map((d) => d.id) : (splitModule?.deps ?? []);

    const factoryFn = idxEntry?.factoryFn ?? splitModule?.factoryFunctionIndex ?? null;
    const outcome = pooled?.get(info.id);
    if (pooled !== undefined && outcome === undefined) throw new Error(`export: render pool returned no result for module ${info.id}`);
    const tiered =
      outcome !== undefined
        ? tieredFromOutcome({ moduleId: info.id, factoryFn, flatText: originalText }, outcome)
        : renderModuleTiered({
            analysis: splitResult.analysis,
            factoryFn,
            moduleId: info.id,
            requestedTier: tier,
            rendersJsx: rendersJsxTag,
            moduleName,
            flatText: originalText,
          });
    for (const h of tiered.helpersUsed) helpersUsedAll.add(h);
    // A flat (or stub) module is the split render's text, which calls the
    // split's own helper set; the readable render's set does not cover it
    // (export-boot L4: `__hbc_pnames` missing under --tier flat).
    if (tiered.tier !== "passes" && tiered.tier !== "jsx") for (const h of splitResult.helpersUsed) helpersUsedAll.add(h);
    if (tiered.unresolved !== undefined) unresolved.push(tiered.unresolved);

    const rewriteOpts = {
      path: exportInfo.path,
      registryPath: "src/_hbc/registry.js",
      pathOf,
      tier: tiered.tier,
      bucket: exportInfo.bucket,
      factoryFunctionIndex: splitModule?.factoryFunctionIndex ?? -1,
      boundaryPackage: plan.boundaryPackage,
    };
    let text =
      tiered.tier === "passes" || tiered.tier === "jsx"
        ? wrapReadableModule(tiered.code, info.id, depIds, rewriteOpts).text
        : rewriteModuleFile(tiered.code, info.id, rewriteOpts).text;
    let finalTier: RenderedTier = tiered.tier;
    let finalReason = tiered.tierDowngradeReason;
    // Safety net: never write a module file that does not parse. Drop down
    // the ladder -- the flat text (when the failing render was a readable
    // one), then a throwing stub -- and record it (EXPORT.json `unresolved`
    // kind "syntax-check-failed" plus the module's `tierDowngradeReason`).
    const syntaxError = syntaxCheck(text, exportInfo.path);
    if (syntaxError !== null) {
      let fallback: string | null = null;
      if (tiered.tier === "passes" || tiered.tier === "jsx") {
        const flat = rewriteModuleFile(originalText, info.id, { ...rewriteOpts, tier: "flat" }).text;
        if (syntaxCheck(flat, exportInfo.path) === null) {
          fallback = flat;
          finalTier = "flat";
          for (const h of splitResult.helpersUsed) helpersUsedAll.add(h);
        }
      }
      if (fallback === null) {
        fallback = rewriteModuleFile(syntaxStubFlatText(info.id, splitModule?.deps ?? depIds, `the ${tiered.tier} render does not parse`), info.id, { ...rewriteOpts, tier: "stub" }).text;
        finalTier = "stub";
      }
      text = fallback;
      finalReason = `the ${tiered.tier} render failed the export syntax check (${syntaxError}); wrote the ${finalTier} render instead`;
      unresolved.push({ kind: "syntax-check-failed", detail: `module ${info.id} (${exportInfo.path}): ${finalReason}` });
    }
    files.set(exportInfo.path, text);

    modulesForManifest.push({
      id: info.id,
      path: exportInfo.path,
      bucket: exportInfo.bucket,
      tier: finalTier,
      tierDowngradeReason: finalReason,
      rendersJsx: rendersJsxTag,
      owner: exportInfo.package,
      eagerDeps,
      lazyDeps,
    });
  }

  files.set("src/_hbc/registry.js", buildRegistryJs(plan.boundaryPackage, opts.instrument === "modules"));
  files.set("src/_hbc/helpers.js", buildHelpersJs([...helpersUsedAll]));

  progress("rendering done; recovering app name and writing the manifest");
  const appName = recoverAppName(splitResult.files, splitResult.modules, opts.appName);
  const rn = resolveReactNativeVersion(report, opts.rnVersion);

  files.set("package.json", `${JSON.stringify(buildPackageJson({ appName: appName.name, report, rnVersion: rn.version }), null, 2)}\n`);
  files.set("app.json", `${JSON.stringify(buildAppJson(appName.name), null, 2)}\n`);
  files.set("babel.config.js", buildBabelConfigJs(rn.version));
  files.set("metro.config.js", buildMetroConfigJs(rn.version));
  // The entry module's REAL export-tree path — never assume it landed at a
  // fixed `src/index.js` (see `buildIndexJs`'s own comment): a substituted-
  // away entry module (unlikely in practice but not provably impossible)
  // also falls back to null here, same as an unresolved entry module id.
  const entryPath =
    splitResult.entryModuleId !== null && !plan.replacedModules.has(splitResult.entryModuleId)
      ? (exportInfoById.get(splitResult.entryModuleId)?.path ?? null)
      : null;
  // Spec 33 L1: the run-before-main modules (RN's InitializeCore) run
  // first, in the original's order; a substituted-away one is left out.
  const runBeforeMain = splitResult.startupModuleIds
    .filter((id) => id !== splitResult.entryModuleId && !plan.replacedModules.has(id))
    .flatMap((id) => {
      const path = exportInfoById.get(id)?.path;
      return path !== undefined ? [{ id, path }] : [];
    });
  files.set("index.js", buildIndexJs(splitResult.entryModuleId, entryPath, runBeforeMain));
  files.set(".gitignore", buildGitignore());

  const bundleSha256 = createHash("sha256").update(bytes).digest("hex");
  if (splitResult.entryModuleId === null) {
    unresolved.push({ kind: "no-entry-module", detail: "MODULES.json's entry could not be resolved from the bundle's global function" });
  } else if (entryPath === null) {
    unresolved.push({ kind: "entry-module-path-unknown", detail: `module ${splitResult.entryModuleId}: entry module's export-tree path is unknown (substituted away)` });
  }
  if (rn.version === null) {
    unresolved.push({
      kind: "framework-version-unknown",
      detail: `no react-native version detected and no known RN range for HBC v${splitResult.module.header.version}`,
    });
  }
  unresolved.push(...plan.unresolved);

  const dependencies: Record<string, { version: string; kind: string; source: string; confidence: number | null; note?: string }> = {};
  for (const [name, d] of Object.entries(exportDependencies(report, rn.version))) {
    dependencies[name] = { version: d.version, kind: "dependency", source: d.level === "confirmed" ? "deps-confirmed" : `deps-${d.level}${d.versionDerived ? "-name-only" : ""}`, confidence: d.confidence, ...(d.note === undefined ? {} : { note: d.note }) };
  }

  const manifest = buildExportManifest({
    hbc2jsVersion: VERSION,
    gitSha: null,
    tier,
    substitute: substituteMode,
    namesOverlay: null,
    bundleSha256,
    bytes: bytes.length,
    hbcVersion: splitResult.module.header.version,
    // Total module count includes both kept (`modulesForManifest`) and
    // substituted-away (`plan.substitutions[].replacedModules`) ids --
    // `buildExportManifest`'s coverage invariant is exactly "these two sets
    // partition `moduleCount`" (spec §6).
    moduleCount: segregated.modules.length,
    entryModule: splitResult.entryModuleId,
    appName: appName.name,
    appNameSource: appName.source,
    reactNative: { version: rn.version, source: rn.source, consistentWithHbc: rn.consistentWithHbc, expectedRange: rn.expectedRange },
    dependencies,
    modules: modulesForManifest,
    substitutions: plan.substitutions,
    unresolved,
    leftOut: ["android/", "ios/", "assets", "lockfile", "typescript", "sourcemaps"],
  });

  files.set("EXPORT.json", `${JSON.stringify(manifest, null, 2)}\n`);

  return { files, manifest };
}

/** Writes an `ExportResult.files` map to `outDir`, refusing a non-empty
 *  target unless `overwrite` is set (spec 10 §1.3's convention: overwriting
 *  an existing tree needs an explicit opt-in, the default refuses so nothing
 *  is silently merged into an unrelated directory). Never partially writes:
 *  the whole map is already built in memory by the time this runs. */
export function writeExportResult(files: ReadonlyMap<string, string>, outDir: string, overwrite: boolean): void {
  if (!overwrite && existsSync(outDir) && readdirSync(outDir).length > 0) {
    throw new Hbc2jsError(ErrorCode.E_USAGE, `export: ${outDir} already exists and is not empty (pass --overwrite)`);
  }
  mkdirSync(outDir, { recursive: true });
  for (const [rel, text] of files) {
    const full = join(outDir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
}
