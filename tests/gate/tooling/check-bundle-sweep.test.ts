import { test } from "node:test";
import assert from "node:assert/strict";
import { symlinkSync, readFileSync, realpathSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { loadConfig, runBuild } from "metro";
import { requireSweep } from "../../support/tiers.ts";
import { repoRoot } from "../../support/paths.ts";
import { cleanup, exportTo, IMPLEMENTED } from "../export/support.ts";
import { checkBundle } from "../../../src/tooling/check-bundle.ts";

const SKIP = { skip: IMPLEMENTED ? false : "docs/specs/29-export.md not implemented yet (lane item 6a)" };

const HELD_OUT_RELEASE = join(
  repoRoot(), "tests", "fixtures", "bundles", "react-navigation-example-0.85.3", "react-navigation-example.hbc",
);

test("sweep: check-bundle reports ok on the held-out app's real Metro output", SKIP, async (t) => {
  if (!requireSweep(t)) return;
  const { out, run } = exportTo(HELD_OUT_RELEASE, ["--tier", "flat", "--substitute", "none"]);
  try {
    assert.equal(run.status, 0, `export failed: ${run.stderr}`);
    const repoNodeModules = realpathSync(join(repoRoot(), "node_modules"));
    symlinkSync(repoNodeModules, join(out, "node_modules"));
    const config = await loadConfig({ cwd: out, watchFolders: [repoNodeModules] });
    const bundleOut = join(out, "android.bundle.js");
    await runBuild(config, { entry: "index.js", platform: "android", dev: false, minify: false, out: bundleOut });

    const text = readFileSync(bundleOut, "utf8");
    const result = await checkBundle(text, { root: dirname(bundleOut), fileExists: existsSync });
    assert.equal(
      result.ok,
      true,
      `check-bundle found defects on the held-out app's large bundle: ${JSON.stringify(
        { missingRequires: result.missingRequires, duplicateIds: result.duplicateIds, freeGlobals: result.freeGlobals, missingAssets: result.missingAssets },
        null,
        2,
      )}`,
    );
  } finally {
    cleanup(out);
  }
});
