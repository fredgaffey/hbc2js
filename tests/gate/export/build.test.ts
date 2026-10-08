import { test } from "node:test";
import assert from "node:assert/strict";
import { symlinkSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, runBuild } from "metro";
import { requireSweep } from "../../support/tiers.ts";
import { repoRoot } from "../../support/paths.ts";
import { cleanup, exportTo, IMPLEMENTED } from "./support.ts";

const SKIP = { skip: IMPLEMENTED ? false : "docs/specs/29-export.md not implemented yet" };

// The held-out app's RELEASE bundle (not the .debug.hbc sibling).
const HELD_OUT_RELEASE = join(
  repoRoot(), "tests", "fixtures", "bundles", "react-navigation-example-0.85.3", "react-navigation-example.hbc",
);

test("spec 29 §0: the exported held-out app bundles with Metro, offline", SKIP, async (t) => {
  if (!requireSweep(t)) return;
  // --tier flat: the cheapest tier that still produces a real tree (6c's own
  // held-out substitution tests use it for the same reason -- this is a
  // build-plumbing proof, not a per-module render-quality test, and the
  // held-out app is ~616 modules under load average ~14 on this box).
  // --substitute none: `--substitute safe` (the CLI default) redirects a
  // substituted package's require to the REAL npm package
  // (react-native-gesture-handler, @react-native-async-storage/async-storage
  // on this fixture -- spec 29 §5) -- correct once `npm install` has fetched
  // it, but this test proves the OFFLINE claim: every specifier resolves
  // against the PINNED devDependency set already on disk (react, react-
  // native, metro and friends), no network, ever. `none` keeps every module
  // vendored under src/_vendor, so the tree never names a package this repo
  // does not already have installed.
  const { out, run } = exportTo(HELD_OUT_RELEASE, ["--tier", "flat", "--substitute", "none"]);
  try {
    assert.equal(run.status, 0, `export failed: ${run.stderr}`);

    // Resolve node_modules for the exported tree from THIS repo -- no
    // install, no network. A symlink makes ordinary hierarchical `node_modules`
    // resolution work; Metro's own watcher then reports the file's REAL
    // (symlink-resolved) path back, which must also be inside a watched
    // root, or every transform fails with "Failed to get the SHA-1 for" --
    // so the real repo node_modules directory is added as a second
    // `watchFolders` entry alongside the export tree itself.
    const repoNodeModules = realpathSync(join(repoRoot(), "node_modules"));
    symlinkSync(repoNodeModules, join(out, "node_modules"));

    const config = await loadConfig({ cwd: out, watchFolders: [repoNodeModules] });
    // `runBuild` appends its own `.js` extension to `out` (metro's own
    // `outputBundle` helper), so the real artifact lands at `android.bundle.js`.
    const bundleOut = join(out, "android.bundle.js");
    await runBuild(config, {
      entry: "index.js",
      platform: "android",
      dev: false,
      minify: false,
      out: bundleOut,
    });

    const stat = statSync(bundleOut);
    assert.ok(stat.size > 1000, `bundle is suspiciously small: ${stat.size} bytes`);
    const bundle = readFileSync(bundleOut, "utf8");
    assert.match(bundle, /__d\(/, "bundle has no Metro module registrations (__d(...))");
  } finally {
    cleanup(out);
  }
});
