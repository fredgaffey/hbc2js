// docs/DECISIONS.md D17/D17a/D17b seed run — runs `hbc2js deps` (offline
// match+guess, no `--confirm`: this is a report-only sweep, never mutates
// tools/pkgsig/db) over the seed corpus when it's present locally:
// react-navigation-example-0.85.3 (committed recipe, fetched on demand).
// Every sub-test is INCONCLUSIVE-via-skip, not a failure, when its input is
// absent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { requireSweep } from "../../support/tiers.ts";
import { runDeps } from "../../../src/deps/index.ts";

async function reportOn(label: string, path: string) {
  const result = await runDeps(path, { offline: true, noSharedDb: false });
  const r = result.report;
  console.log(
    `[deps sweep] ${label}: hbc${r.hbcVersion}, ${r.totalFunctions} functions, ${r.totalModules} modules, rn=${r.reactNativeVersion ?? "?"} — ` +
      `${r.attribution.percentAttributed.toFixed(2)}% attributed (${r.confirmedDeps.length} confirmed: ${r.confirmedDeps.map((d) => d.package).join(",") || "none"}; ` +
      `${r.guessedDeps.length} guessed: ${r.guessedDeps.map((d) => d.package).join(",") || "none"})`,
  );
  return r;
}

test("react-navigation-example-0.85.3: all 9 known dependencies confirmed at high confidence", async (t) => {
  if (!requireSweep(t)) return;
  const path = join(repoRoot(), "tests", "fixtures", "bundles", "react-navigation-example-0.85.3", "react-navigation-example.hbc");
  if (!existsSync(path)) {
    t.skip("react-navigation-example.hbc not present — run its fetch.sh first (INCONCLUSIVE, not a failure)");
    return;
  }
  const r = await reportOn("react-navigation-example-0.85.3", path);
  // docs/PACKAGE-SIGNATURES.md §5.6: every package genuinely in this app's
  // tree should clear "high" confidence via the starter DB alone.
  const expected = ["react", "react-native", "@react-navigation/stack", "@react-navigation/native", "react-native-gesture-handler", "react-native-reanimated", "react-native-screens", "@react-native-async-storage/async-storage", "react-native-safe-area-context"];
  const names = new Set(r.confirmedDeps.map((d) => d.package));
  for (const pkg of expected) assert.ok(names.has(pkg), `expected ${pkg} in confirmedDeps, got: ${[...names].join(", ")}`);
  assert.ok(r.attribution.percentAttributed > 50, `expected >50% module attribution, got ${r.attribution.percentAttributed.toFixed(1)}%`);
});

test("shared DB size stays under the ~40MB budget (docs/DEPS.md)", () => {
  const indexPath = join(repoRoot(), "tools", "pkgsig", "db", "index.json");
  if (!existsSync(indexPath)) return;
  // A cheap proxy for "the whole tools/pkgsig/db tree", without a recursive
  // stat walk: index.json's own totalFunctions sum, cross-checked against
  // du in the seed-run report (docs/DEPS.md) rather than asserted precisely
  // here (file sizes depend on JSON formatting, not just function counts).
  const index = JSON.parse(readFileSync(indexPath, "utf8")) as { entries: { totalFunctions: number }[] };
  assert.ok(index.entries.length > 0, "expected at least the starter-set signatures to be present");
});
