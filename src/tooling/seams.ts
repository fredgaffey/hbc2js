import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { buildInventoryFromModule, type InventoryModule, type ModuleInventory } from "../deps/inventory.ts";
import { parseHbc } from "../parse/module.ts";
import type { JsTransformerConfig, JsTransformOptions } from "metro-transform-worker";

const metroRequire = createRequire(import.meta.url);

export type Platform = "ios" | "android";

/** The same three-tier ladder `src/deps/match.ts` uses for whole-package
 *  scoring (exact hash > fuzzy opcode-shape hash corroborated by an
 *  identical string set > bare fuzzy hash alone), applied here to exactly
 *  one candidate pair rather than a whole DB. */
export type MatchTier = "exact" | "fuzzy+strings" | "fuzzy-only" | "nested-strings";

export interface SeamFinding {
  readonly name: string;
  readonly bundleModuleId: number | null;
  readonly bundleModuleIdSource: string | null;
  readonly bundleFactoryFunctionIndex: number;
  /** The platform whose published variant the bundle's module body actually
   *  matches — the OTHER one from `--platform`, by definition of a seam. */
  readonly matchedPlatform: Platform;
  readonly matchTier: MatchTier;
}

export interface UnclassifiedVariant {
  readonly name: string;
  readonly reason: string;
}

export interface SeamsResult {
  readonly platform: Platform;
  readonly bundleModuleCount: number;
  readonly variantModuleCount: number;
  readonly neutralModuleCount: number;
  readonly seams: readonly SeamFinding[];
  readonly unclassifiable: readonly UnclassifiedVariant[];
  readonly hermescPath: string | null;
  readonly hermescSource: string;
  readonly totals: { readonly seams: number; readonly unclassifiable: number };
}

export interface SeamsOptions {
  readonly rnDir: string;
  readonly platform: Platform;
  /** Defaults to `tools/hermesc` under `process.cwd()` — the same
   *  resolution `src/deps/index.ts` uses for `--confirm`. Overridable for
   *  tests. */
  readonly hermescDir?: string;
}

const SKIP_DIRS = new Set([".git", "node_modules", "__tests__", "__mocks__"]);
const VARIANT_RE = /^(.*)\.(ios|android)\.js$/;
const PLAIN_JS_RE = /^(.*)\.js$/;

interface RnFile {
  ios?: string;
  android?: string;
  plain?: string;
}

interface RnScan {
  readonly variantKeys: readonly string[];
  readonly neutralCount: number;
  readonly files: ReadonlyMap<string, RnFile>;
}

function walkJsFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        out.push(join(dir, entry.name));
      }
    }
  }
  return out;
}

/** Groups every `.js` file under `rnDir` by its platform-suffix-stripped
 *  key. A key with both a `.ios.js` and a `.android.js` file is a "variant
 *  module" (seam-checked below); every other key (a lone `.js`, or a lone
 *  single-platform file with no counterpart) is "neutral" for this report's
 *  purposes — it cannot produce a cross-platform seam because there is only
 *  ever one body Metro could have picked. */
function scanRnDir(rnDir: string): RnScan {
  const files = new Map<string, RnFile>();
  for (const abs of walkJsFiles(rnDir)) {
    const rel = relative(rnDir, abs).split(sep).join("/");
    const vm = VARIANT_RE.exec(rel);
    if (vm !== null) {
      const key = vm[1]!;
      const entry = files.get(key) ?? {};
      if (vm[2] === "ios") entry.ios = abs;
      else entry.android = abs;
      files.set(key, entry);
      continue;
    }
    const pm = PLAIN_JS_RE.exec(rel);
    if (pm !== null) {
      const key = pm[1]!;
      const entry = files.get(key) ?? {};
      entry.plain = abs;
      files.set(key, entry);
    }
  }
  const variantKeys = [...files.entries()].filter(([, f]) => f.ios !== undefined && f.android !== undefined).map(([k]) => k);
  const variantSet = new Set(variantKeys);
  const neutralCount = [...files.keys()].filter((k) => !variantSet.has(k)).length;
  return { variantKeys, neutralCount, files };
}

function nameFromKey(key: string): string {
  return key.split("/").pop() ?? key;
}

/** G1 (block-2026-09-23-next.md) — `metro-transform-worker`'s own
 *  `JsFileWrapping.wrapModule` (the SAME wrapper a real Metro bundle uses)
 *  already emits `<globalPrefix>__d(function(...) {...});` for us — see
 *  `transformWithMetro` below. It stops at ONE argument (the factory): the
 *  module id and dependency-id array are only assembled later, at real
 *  bundle-serialization time, which this tool never runs. `src/deps/dscan.ts`'s
 *  structural scanner requires a 3-argument `__d(factory, id, deps)` `Call5`
 *  to recognise a module registration at all (the same convention this
 *  tool's `bundleSource.js` test fixture and every real Metro bundle satisfy)
 *  — so the id/deps are appended here by string surgery on the ONE trailing
 *  `);` metro-transform-worker's `js/module` output always ends with
 *  (verified: `wrapModule`'s AST is always exactly one top-level
 *  `ExpressionStatement` wrapping one single-argument `CallExpression`, with
 *  no code after it — `compact: false`, `unstable_compactOutput: false` in
 *  the config keep that single trailing `);` predictable even as trailing
 *  whitespace/newlines vary). The id (`0`) and deps (`[]`) values themselves
 *  are never read by anything downstream — `runSeams` matches purely on
 *  compiled bytecode fingerprints, never module ids — so any fixed value
 *  works, same as the old hand-rolled wrap this replaces. */
function finalizeMetroModuleWrap(code: string): string {
  const trimmed = code.trimEnd();
  if (!trimmed.endsWith(");")) {
    throw new Error(`metro-transform-worker output did not end with the expected __d(...) call: ...${trimmed.slice(-60)}`);
  }
  return `${trimmed.slice(0, -2)}, 0, []);\n`;
}

interface CandidateModule {
  readonly inventory: ModuleInventory;
  readonly module: InventoryModule;
}

// `metro-transform-worker` ships its own `.d.ts` (imported by real type,
// `JsTransformerConfig`/`JsTransformOptions` above -- no ambient shim
// needed). Its own `transform()` internally `require()`s a "babel
// transformer" module by STRING PATH (`config.babelTransformerPath`), never
// an ES import TypeScript would need to resolve -- `@react-native/metro-babel-transformer`
// (RN's own glue module wrapping `@react-native/babel-preset` in the
// interface `metro-transform-worker` expects, pinned directly here at the
// same 0.85.3, previously only a transitive dependency of `react-native`/
// `@react-native/metro-config`) is only ever named as a `metroRequire.resolve()`
// string argument below, so it needs no ambient declare either, unlike F5's
// direct `import("@react-native/babel-preset")`. `@babel/core`/
// `@react-native/babel-preset`'s ambient shim (`babel-preset-ambient.d.ts`)
// was therefore retired -- neither is imported by any TS source anymore
// (confirmed by grep); both stay pinned devDependencies regardless (still
// used directly by `src/export/boilerplate.ts`'s generated-project text and
// transitively required by the babel transformer glue).
//
// Lazy `import()`, same pattern as `src/util/js-ast.ts`'s `@babel/parser`
// loader: both new packages are `devDependencies` only (package.json
// `dependencies` stays `{}`), loaded inside a function so the published
// `dist/` runtime path (`src/decompile.ts` and everything it statically
// imports) never reaches Metro/Babel. `seams.ts` itself is dev-loop tooling,
// wired from `src/cli.ts`'s `seams` command only -- never imported from the
// decompile path either.
interface MetroTransformWorkerModule {
  transform: (
    config: JsTransformerConfig,
    projectRoot: string,
    filename: string,
    data: Buffer,
    options: JsTransformOptions,
  ) => Promise<{ output: readonly { data: { code: string } }[] }>;
}
let cachedMetroTransformWorker: MetroTransformWorkerModule | undefined;

async function loadMetroTransformWorker(): Promise<MetroTransformWorkerModule> {
  if (cachedMetroTransformWorker !== undefined) return cachedMetroTransformWorker;
  try {
    // Dynamic on purpose -- see the block comment above.
    const mod = await import("metro-transform-worker");
    cachedMetroTransformWorker = mod as unknown as MetroTransformWorkerModule;
  } catch {
    throw new Error(
      "hbc2js's `seams` tool needs the 'metro-transform-worker' and '@react-native/metro-babel-transformer' " +
        "devDependencies (to run each candidate through Metro's OWN transform pipeline -- Flow/JSX stripping, " +
        "Platform.OS/__DEV__ constant folding, inline-requires -- not a bare Babel preset), which aren't " +
        "installed here. Run `npm install` from the repo root, then retry.",
    );
  }
  return cachedMetroTransformWorker;
}

function buildMetroTransformerConfig(): JsTransformerConfig {
  return {
    assetPlugins: [],
    assetRegistryPath: "react-native/Libraries/Image/AssetRegistry",
    asyncRequireModulePath: metroRequire.resolve("metro-runtime/src/modules/asyncRequire"),
    babelTransformerPath: metroRequire.resolve("@react-native/metro-babel-transformer"),
    dynamicDepsInPackages: "throwAtRuntime",
    enableBabelRCLookup: false,
    enableBabelRuntime: true,
    globalPrefix: "",
    hermesParser: false,
    minifierConfig: {},
    minifierPath: metroRequire.resolve("metro-minify-terser"),
    optimizationSizeLimit: 150 * 1024,
    publicPath: "/assets",
    allowOptionalDependencies: true,
    unstable_dependencyMapReservedName: null,
    unstable_disableModuleWrapping: false,
    unstable_disableNormalizePseudoGlobals: false,
    unstable_compactOutput: false,
    unstable_allowRequireContext: false,
  };
}

function buildMetroTransformOptions(platform: Platform): JsTransformOptions {
  return {
    dev: false,
    experimentalImportSupport: false,
    inlinePlatform: true,
    inlineRequires: true,
    minify: true,
    platform,
    type: "module",
    unstable_transformProfile: "default",
  };
}

/** Runs one candidate variant's published source through Metro's own
 *  transform worker -- see the block comment above for why a bare Babel
 *  preset (F5's fix) was not enough. `platform` must be the variant's OWN
 *  platform (an `.ios.js` file transformed as `platform:"ios"`), not
 *  `opts.platform` (the bundle's platform being checked) -- Metro would
 *  have compiled that file the same way regardless of which platform ends
 *  up bundled, since the transform runs per-source-file, not per-bundle.
 *  Returns the wrapped `__d(function(...) {...});` module code
 *  `finalizeMetroModuleWrap` still needs to append `id, deps` to. */
async function transformWithMetro(source: string, filename: string, platform: Platform): Promise<string> {
  const { transform } = await loadMetroTransformWorker();
  const config = buildMetroTransformerConfig();
  const options = buildMetroTransformOptions(platform);
  const result = await transform(config, process.cwd(), filename, Buffer.from(source, "utf8"), options);
  const out = result.output[0];
  if (out === undefined || out.data.code == null || out.data.code.length === 0) {
    throw new Error(`metro-transform-worker produced no output for ${filename}`);
  }
  return out.data.code;
}

/** Compiles one candidate variant source file with `hermescPath` and
 *  fingerprints the resulting single-module bytecode via the same
 *  `buildInventoryFromModule` the bundle side uses. `filename` is passed
 *  through to the Metro transform stage only (it never reaches hermesc or
 *  the bundle-side output) -- any `.ios.js`/`.android.js`-suffixed name is
 *  fine. Returns `null` when the wrapped source did not register as exactly
 *  one `__d()` module (should not happen for well-formed RN source, but
 *  this tool never guesses at an ambiguous compile). */
async function compileCandidate(hermescPath: string, source: string, filename: string, workDir: string, platform: Platform): Promise<CandidateModule | null> {
  const transformed = await transformWithMetro(source, filename, platform);
  const dir = mkdtempSync(join(workDir, "c-"));
  const srcPath = join(dir, "candidate.js");
  const outPath = join(dir, "candidate.hbc");
  writeFileSync(srcPath, finalizeMetroModuleWrap(transformed), "utf8");
  execFileSync(hermescPath, ["-O", "-emit-binary", `-out=${outPath}`, srcPath], { stdio: "ignore" });
  const bytes = new Uint8Array(readFileSync(outPath));
  const mod = parseHbc(bytes);
  const inventory = buildInventoryFromModule(mod);
  return inventory.modules.length === 1 ? { inventory, module: inventory.modules[0]! } : null;
}

function sameArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function tierOf(a: CandidateModule, b: CandidateModule): MatchTier | "none" {
  const an = a.module;
  const bn = b.module;
  if (an.nestedExactHashSet !== null && an.nestedExactHashSet === bn.nestedExactHashSet) return "exact";
  if (an.nestedFuzzyHashSet !== null && an.nestedFuzzyHashSet === bn.nestedFuzzyHashSet) {
    return sameArray(an.nestedStringConstants, bn.nestedStringConstants) ? "fuzzy+strings" : "fuzzy-only";
  }
  if (an.nestedExactHashSet === null && bn.nestedExactHashSet === null) {
    if (an.stringSetHash === bn.stringSetHash) return "exact";
    if (an.functionIndices.length > 0 && an.fuzzyHashSet === bn.fuzzyHashSet) {
      return sameArray(an.stringConstants, bn.stringConstants) ? "fuzzy+strings" : "fuzzy-only";
    }
  }
  return "none";
}

export function nestedStringsMatch(bundleModule: InventoryModule, iosModule: InventoryModule, androidModule: InventoryModule): Platform | null {
  const iosStrings = iosModule.nestedStringConstants;
  const androidStrings = androidModule.nestedStringConstants;
  if (sameArray(iosStrings, androidStrings)) return null; // identical variant sets -> abstain, never guess.
  const bundleStrings = bundleModule.nestedStringConstants;
  const matchesIos = iosStrings.length >= 3 && sameArray(bundleStrings, iosStrings);
  const matchesAndroid = androidStrings.length >= 3 && sameArray(bundleStrings, androidStrings);
  if (matchesIos === matchesAndroid) return null; // both (impossible given the differ-check above) or neither -> abstain.
  return matchesIos ? "ios" : "android";
}

export async function runSeams(bundleBytes: Uint8Array, opts: SeamsOptions): Promise<SeamsResult> {
  const mod = parseHbc(bundleBytes);
  const bundleInv = buildInventoryFromModule(mod);
  const bundleModules: readonly CandidateModule[] = bundleInv.modules.map((m) => ({ inventory: bundleInv, module: m }));
  const hbcVersion = mod.header.version;
  const hermescDir = opts.hermescDir ?? join(process.cwd(), "tools", "hermesc");
  const hermescPath = join(hermescDir, `v${hbcVersion}`, "hermesc");
  const hermescAvailable = existsSync(hermescPath);

  const scan = scanRnDir(opts.rnDir);
  const seams: SeamFinding[] = [];
  const unclassifiable: UnclassifiedVariant[] = [];

  let workDir: string | null = null;
  try {
    if (hermescAvailable && scan.variantKeys.length > 0) workDir = mkdtempSync(join(tmpdir(), "hbc2js-seams-"));
    for (const key of scan.variantKeys) {
      const name = nameFromKey(key);
      if (!hermescAvailable) {
        unclassifiable.push({ name, reason: `hermesc v${hbcVersion} not available at ${hermescPath}` });
        continue;
      }
      const entry = scan.files.get(key)!;
      let iosCand: CandidateModule | null;
      let androidCand: CandidateModule | null;
      try {
        iosCand = await compileCandidate(hermescPath, readFileSync(entry.ios!, "utf8"), `${name}.ios.js`, workDir!, "ios");
        androidCand = await compileCandidate(hermescPath, readFileSync(entry.android!, "utf8"), `${name}.android.js`, workDir!, "android");
      } catch (e) {
        unclassifiable.push({ name, reason: `could not compile variant(s): ${e instanceof Error ? e.message : String(e)}` });
        continue;
      }
      if (iosCand === null || androidCand === null) {
        unclassifiable.push({ name, reason: "a variant did not compile to exactly one module" });
        continue;
      }
      if (tierOf(iosCand, androidCand) !== "none") {
        unclassifiable.push({ name, reason: "ios and android variants are not distinguishable at any match tier" });
        continue;
      }
      let iosMatches = bundleModules.filter((m) => tierOf(iosCand!, m) !== "none");
      let androidMatches = bundleModules.filter((m) => tierOf(androidCand!, m) !== "none");
      // G1c: nested-strings is the fourth rung, tried only once nested-exact/
      // nested-fuzzy/whole-set (`tierOf`) found NOTHING at all for this
      // candidate pair — never as a tie-breaker over a `tierOf` match, and
      // never for a pair `tierOf` already found indistinguishable from each
      // other above. See `nestedStringsMatch`'s own doc comment for the
      // preconditions that keep this from ever coin-flipping.
      let usedNestedStringsTier = false;
      if (iosMatches.length === 0 && androidMatches.length === 0) {
        const nestedIos: CandidateModule[] = [];
        const nestedAndroid: CandidateModule[] = [];
        for (const m of bundleModules) {
          const matched = nestedStringsMatch(m.module, iosCand.module, androidCand.module);
          if (matched === "ios") nestedIos.push(m);
          else if (matched === "android") nestedAndroid.push(m);
        }
        if (nestedIos.length > 0 || nestedAndroid.length > 0) {
          iosMatches = nestedIos;
          androidMatches = nestedAndroid;
          usedNestedStringsTier = true;
        }
      }
      if (iosMatches.length === 0 && androidMatches.length === 0) {
        unclassifiable.push({ name, reason: "neither variant matched any module in the bundle" });
        continue;
      }
      if (iosMatches.length > 0 && androidMatches.length > 0) {
        unclassifiable.push({ name, reason: "both variants matched something in the bundle" });
        continue;
      }
      if (iosMatches.length > 1 || androidMatches.length > 1) {
        unclassifiable.push({ name, reason: "more than one bundle module matched the same variant" });
        continue;
      }
      const matchedOnIos = iosMatches.length === 1;
      const matchedPlatform: Platform = matchedOnIos ? "ios" : "android";
      if (matchedPlatform === opts.platform) continue; // correct platform baked in — not a seam.
      const bundleCand = (matchedOnIos ? iosMatches : androidMatches)[0]!;
      const candidateCand = matchedOnIos ? iosCand : androidCand;
      seams.push({
        name,
        bundleModuleId: bundleCand.module.localModuleId,
        bundleModuleIdSource: bundleCand.module.localModuleId === null ? "module-id-not-recovered" : null,
        bundleFactoryFunctionIndex: bundleCand.module.factoryFunctionIndex,
        matchedPlatform,
        matchTier: usedNestedStringsTier ? "nested-strings" : (tierOf(candidateCand, bundleCand) as MatchTier),
      });
    }
  } finally {
    if (workDir !== null) rmSync(workDir, { recursive: true, force: true });
  }

  return {
    platform: opts.platform,
    bundleModuleCount: bundleInv.modules.length,
    variantModuleCount: scan.variantKeys.length,
    neutralModuleCount: scan.neutralCount,
    seams,
    unclassifiable,
    hermescPath: hermescAvailable ? hermescPath : null,
    hermescSource: hermescAvailable ? "found" : `missing-hermesc-v${hbcVersion}`,
    totals: { seams: seams.length, unclassifiable: unclassifiable.length },
  };
}

/** Thrown for a bad `--rn` path — the CLI's "could not measure" exit. */
export function assertRnDirExists(rnDir: string): void {
  if (!existsSync(rnDir) || !statSync(rnDir).isDirectory()) {
    throw new Error(`--rn path is not a directory: ${rnDir}`);
  }
}
