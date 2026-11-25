// Offline bundling check for an exported tree (spec 29 §4.6). Bundles with
// the Metro + babel transformer installed in the EXPORT TREE's own
// node_modules (its `npm install` fetches the toolchain for its RN version),
// whatever RN minor the tree names in its own babel.config.js / package.json.
// Only a repo checkout (hbc2js's devDependencies on disk) may lend its own
// toolchain to a tree that has no node_modules; an npm-installed hbc2js ships
// no Metro (0.1.2 benchmark b1: "Cannot find package 'metro'").
import { symlinkSync, realpathSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** The Metro API surface used here (resolved at runtime, not imported). */
interface MetroSerializer { getPolyfills(o: { platform: string }): readonly string[]; getModulesRunBeforeMainModule?: unknown }
interface MetroConfig { serializer: MetroSerializer; resolver: object; transformer: object }
interface MetroApi {
  loadConfig(o: { cwd: string; watchFolders: string[] }): Promise<MetroConfig>;
  runBuild(config: object, o: { entry: string; platform: string; dev: boolean; minify: boolean; out: string }): Promise<unknown>;
}

/** Env var the offline transformer (loaded by Metro in its workers, which
 *  inherit the environment) reads to find the upstream babel transformer. */
export const OFFLINE_UPSTREAM_ENV = "HBC2JS_OFFLINE_BABEL_TRANSFORMER";

function canResolve(req: NodeJS.Require, name: string): boolean {
  try { req.resolve(name); return true; } catch { return false; }
}

/** `name` resolved from the tree, else from beside one of `via` (packages the
 *  tree does have, e.g. a non-hoisted transitive dependency of RN's config). */
function resolveFrom(req: NodeJS.Require, name: string, via: readonly string[]): string {
  try { return req.resolve(name); } catch { /* try the carriers */ }
  for (const v of via) {
    try { return createRequire(req.resolve(v)).resolve(name); } catch { /* next */ }
  }
  return req.resolve(name); // throws the standard not-found error
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const OFFLINE_TRANSFORMER = join(HERE, "offline-babel-transformer.cjs");

export interface OfflineBundleResult { readonly bundlePath: string }

/** Toolchain from `<tree>/node_modules`. When the tree has none and
 *  `repoRoot` is a checkout with Metro installed, its node_modules are
 *  symlinked into `tree` (Metro reports real paths, so the real directory is
 *  a second watch folder). Otherwise fails asking for `npm install` in the
 *  tree. Writes `<tree>/android.bundle.js`. Never modifies the tree's own
 *  config files. */
export async function offlineBundle(treeIn: string, repoRootIn: string): Promise<OfflineBundleResult> {
  // createRequire needs absolute paths (0.1.2 benchmark b2: a relative export dir).
  const tree = resolve(treeIn);
  const repoRoot = resolve(repoRootIn);
  const treeReq = createRequire(join(tree, "package.json"));
  const link = join(tree, "node_modules");
  if (!canResolve(treeReq, "metro")) {
    if (existsSync(link) || !canResolve(createRequire(join(repoRoot, "package.json")), "metro")) {
      throw new Error(`Metro is not installed in the export tree ${tree}: run \`npm install\` in ${tree} first (the export's own node_modules supply the bundler for its React Native version)`);
    }
    symlinkSync(realpathSync(join(repoRoot, "node_modules")), link);
  }
  const realModules = realpathSync(link);
  const metro = treeReq(resolveFrom(treeReq, "metro", [])) as MetroApi;
  const upstreamTransformer = resolveFrom(treeReq, "@react-native/metro-babel-transformer", ["@react-native/metro-config", "react-native/package.json"]);
  const loaded = await metro.loadConfig({ cwd: tree, watchFolders: realModules !== link ? [realModules] : [] });
  // Applied AFTER loading: `loadConfig`'s second argument is only a default,
  // which the tree's own metro.config.js (the original toolchain's
  // getDefaultConfig) overrides.
  // Spec 33 L1: a pre-0.73 tree's metro.config.js is bare `metro-config`,
  // whose defaults have NO polyfills. The original toolchain never bundles
  // that way: `react-native bundle` (the RN CLI) layers RN's serializer
  // defaults on top, so RN's polyfills (error-guard installs
  // `global.ErrorUtils`, which InitializeCore needs) run before any module.
  // Mirror the CLI with the installed RN's defaults when the tree's own
  // config brings none.
  let serializer = loaded.serializer;
  if (serializer.getPolyfills({ platform: "android" }).length === 0) {
    const rnDefaults = (treeReq(resolveFrom(treeReq, "@react-native/metro-config", ["react-native/package.json"])) as { getDefaultConfig(root: string): { serializer: Partial<typeof serializer> } }).getDefaultConfig(tree).serializer;
    serializer = { ...serializer, ...(rnDefaults.getPolyfills !== undefined ? { getPolyfills: rnDefaults.getPolyfills } : {}), ...(rnDefaults.getModulesRunBeforeMainModule !== undefined ? { getModulesRunBeforeMainModule: rnDefaults.getModulesRunBeforeMainModule } : {}) };
  }
  // Spec 33 L2: a silent reporter (Metro's banner and progress went to
  // stdout, corrupting `equiv --boot --json`) and no watchman (a one-shot
  // build gains nothing from it, and a recrawling watchman cost ~85 s).
  const config = { ...loaded, serializer, reporter: { update: (): void => {} }, resolver: { ...loaded.resolver, useWatchman: false }, transformer: { ...loaded.transformer, babelTransformerPath: OFFLINE_TRANSFORMER } };
  const bundlePath = join(tree, "android.bundle.js");
  const prev = process.env[OFFLINE_UPSTREAM_ENV];
  process.env[OFFLINE_UPSTREAM_ENV] = upstreamTransformer;
  try {
    await metro.runBuild(config, { entry: "index.js", platform: "android", dev: false, minify: false, out: bundlePath });
  } finally {
    if (prev === undefined) delete process.env[OFFLINE_UPSTREAM_ENV];
    else process.env[OFFLINE_UPSTREAM_ENV] = prev;
  }
  return { bundlePath };
}
