import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import { splitProject } from "../split/index.ts";
import { segregateSplitTree } from "../split/segregate.ts";
import { runDeps } from "../deps/index.ts";
import type { DepsReport } from "../deps/report.ts";
import { VERSION } from "../version.ts";
import { buildIndexRows } from "../artifact/index-rows.ts";
import { exportPathForModule } from "./layout.ts";
import type { ExportModuleInfo } from "./layout.ts";
import { buildHelpersJs, buildRegistryJs } from "./registry.ts";
import { rewriteModuleFile, wrapReadableModule } from "./rewrite.ts";
import { renderModuleTiered } from "./tiers.ts";
import type { ExportManifestModule, ExportManifestUnresolved } from "./manifest.ts";
import { buildExportManifest } from "./manifest.ts";
import { planSubstitutions, tierConfidenceScore } from "./substitute.ts";
import type { SubstituteMode } from "./substitute.ts";
import {
  buildAppJson,
  buildBabelConfigJs,
  buildGitignore,
  buildIndexJs,
  buildMetroConfigJs,
  buildPackageJson,
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
}

export interface ExportResult {
  readonly files: ReadonlyMap<string, string>;
  readonly manifest: Record<string, unknown>;
}

/** `hbc2js export <bundle.hbc> --out <dir>` (spec 29 §2-§4). Builds the
 *  whole file map in memory; write it with `writeExportResult`. */
export async function exportProject(bundlePath: string, opts: ExportOptions = {}): Promise<ExportResult> {
  const bytes = readFileSync(bundlePath);
  const moduleName = basename(bundlePath);
  const tier = opts.tier ?? "passes";

  // Always the flat (no-passes) split: the ONE whole-bundle parse+analysis
  // this run pays for (§1's pipeline diagram), and every module's flat text
  // is exactly §7.3's rung-2/rung-3 source. Per-module readable rendering
  // (rung 1, `passes`/`jsx`) runs off `splitResult.analysis` below, scoped
  // per module (`renderModuleTiered` -> `renderModuleReadable`, lane item 4)
  // instead of one whole-bundle pass-ladder emit -- so one bad function's
  // pass-ladder failure downgrades ONLY that module, never the whole run.
  const splitResult = splitProject(new Uint8Array(bytes), { moduleName });

  // The deps stage never touches the network from inside `export` — same
  // "no real model / no network in a gate run" rule every other lane
  // observes; `--deps-report` is the escape hatch for a caller that already
  // has a `--confirm`ed report. This is a second, cheap bytecode-inventory
  // scan (`buildInventory`), not a second full decompile — `splitProject`
  // above remains the one expensive parse.
  const report: DepsReport = opts.depsReport ?? (await runDeps(bundlePath, { offline: true })).report;

  // §7.1/§7.2's own inputs (`DepEdge[]`, `rendersJsx`) -- reuses
  // `splitResult.module`/`.analysis` (`analyseForArtifact`), no second parse.
  const { modulesIndex } = buildIndexRows({ bytes, splitResult, passes: {}, strictEnv: false, form: "flat" });
  const moduleIndexById = new Map(modulesIndex.modules.map((m) => [m.id, m]));

  // §5's S1-S4 boundary analysis, over the SAME `DepEdge[]` graph §7.1 built
  // -- no second analysis. `mode: "none"` (the §5.3 escape hatch) short-
  // circuits to the empty plan inside `planSubstitutions` itself.
  const substituteMode: SubstituteMode = opts.substitute ?? "safe";
  const plan = planSubstitutions(report, modulesIndex.modules, substituteMode);

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

  for (const info of segregated.modules) {
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

    const tiered = renderModuleTiered({
      analysis: splitResult.analysis,
      factoryFn: idxEntry?.factoryFn ?? splitModule?.factoryFunctionIndex ?? null,
      moduleId: info.id,
      requestedTier: tier,
      rendersJsx: rendersJsxTag,
      moduleName,
      flatText: originalText,
    });
    for (const h of tiered.helpersUsed) helpersUsedAll.add(h);
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
    const text =
      tiered.tier === "passes" || tiered.tier === "jsx"
        ? wrapReadableModule(tiered.code, info.id, depIds, rewriteOpts).text
        : rewriteModuleFile(tiered.code, info.id, rewriteOpts).text;
    files.set(exportInfo.path, text);

    modulesForManifest.push({
      id: info.id,
      path: exportInfo.path,
      bucket: exportInfo.bucket,
      tier: tiered.tier,
      tierDowngradeReason: tiered.tierDowngradeReason,
      rendersJsx: rendersJsxTag,
      owner: exportInfo.package,
      eagerDeps,
      lazyDeps,
    });
  }

  files.set("src/_hbc/registry.js", buildRegistryJs(plan.boundaryPackage, opts.instrument === "modules"));
  files.set("src/_hbc/helpers.js", buildHelpersJs([...helpersUsedAll]));

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
  files.set("index.js", buildIndexJs(splitResult.entryModuleId, entryPath));
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
  for (const g of report.guessedDeps) {
    unresolved.push({ kind: "guessed-not-installed", detail: `${g.package}: guessed, not confirmed -- not written into package.json` });
  }
  unresolved.push(...plan.unresolved);

  const dependencies: Record<string, { version: string; kind: string; source: string; confidence: number | null }> = {};
  for (const d of report.confirmedDeps) {
    dependencies[d.package] = { version: d.version, kind: "dependency", source: "deps-confirmed", confidence: tierConfidenceScore(d.confidence) };
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
