// Offline bundling check for an exported tree (spec 29 §4.6). Bundles with
// Metro using only what is installed in THIS repo (pinned toolchain), whatever
// RN minor the tree names in its own babel.config.js / package.json.
import { symlinkSync, realpathSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
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
  const config = { ...loaded, transformer: { ...loaded.transformer, babelTransformerPath: OFFLINE_TRANSFORMER } };
  const bundlePath = join(tree, "android.bundle.js");
  await runBuild(config, { entry: "index.js", platform: "android", dev: false, minify: false, out: bundlePath });
  return { bundlePath };
}
