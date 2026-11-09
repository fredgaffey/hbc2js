// Offline bundling check for an exported tree (spec 29 §4.6). Bundles with
// Metro using only what is installed in THIS repo (pinned toolchain), whatever
// RN minor the tree names in its own babel.config.js / package.json.
import { symlinkSync, realpathSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { loadConfig, runBuild } from "metro";

const HERE = dirname(fileURLToPath(import.meta.url));
export const OFFLINE_TRANSFORMER = join(HERE, "offline-babel-transformer.cjs");

export interface OfflineBundleResult { readonly bundlePath: string }

/** `repoRoot` supplies node_modules (symlinked into `tree`; Metro reports real
 *  paths, so the real directory is a second watch folder). Writes
 *  `<tree>/android.bundle.js`. Never modifies the tree's own config files. */
export async function offlineBundle(tree: string, repoRoot: string): Promise<OfflineBundleResult> {
  const repoNodeModules = realpathSync(join(repoRoot, "node_modules"));
  const link = join(tree, "node_modules");
  if (!existsSync(link)) symlinkSync(repoNodeModules, link);
  const loaded = await loadConfig({ cwd: tree, watchFolders: [repoNodeModules] });
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
    const rnDefaults = (createRequire(join(repoNodeModules, "noop.js"))("@react-native/metro-config") as { getDefaultConfig(root: string): { serializer: Partial<typeof serializer> } }).getDefaultConfig(tree).serializer;
    serializer = { ...serializer, ...(rnDefaults.getPolyfills !== undefined ? { getPolyfills: rnDefaults.getPolyfills } : {}), ...(rnDefaults.getModulesRunBeforeMainModule !== undefined ? { getModulesRunBeforeMainModule: rnDefaults.getModulesRunBeforeMainModule } : {}) };
  }
  const config = { ...loaded, serializer, transformer: { ...loaded.transformer, babelTransformerPath: OFFLINE_TRANSFORMER } };
  const bundlePath = join(tree, "android.bundle.js");
  await runBuild(config, { entry: "index.js", platform: "android", dev: false, minify: false, out: bundlePath });
  return { bundlePath };
}
