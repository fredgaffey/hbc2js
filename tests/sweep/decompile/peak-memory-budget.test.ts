// The budget's `measured` block records provenance on purpose (host, load
// average, individual run values): peak RSS is measured, not guessed, and a
// future reader needs to be able to tell a real regression from a
// re-tuned budget apart from a bad measurement. It was taken on the remote build node (ssh,
// idle, load average 0.07-0.69) because at the time this test was written
// the Mac this repo normally gates on had SEVEN concurrent workers running
// (load average ~46-64) -- a memory measurement on a loaded box is not
// reliable (peak RSS under memory pressure/swapping is not the same
// quantity as peak RSS alone), so this test's own budget lookup carries no
// machine check: the budget travels with the repo, not with whichever box
// happens to run the gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { loadavg } from "node:os";
import { repoRoot } from "../../support/paths.ts";
import { requireSweep } from "../../support/tiers.ts";

// react-navigation-example.hbc is the RELEASE build of the held-out app.
// react-navigation-example.debug.hbc is a different, larger build -- never
// conflate the two (docs/BUGS.md history: this mixup has burned this
// project before).
const HBC = join(repoRoot(), "tests", "fixtures", "bundles", "react-navigation-example-0.85.3", "react-navigation-example.hbc");
const CHILD = join(repoRoot(), "tests", "support", "peak-rss-child.ts");
const BUDGET_PATH = join(repoRoot(), "tests", "sweep", "decompile", "peak-memory-budget.json");

interface Budget {
  readonly rssKbBudget: number;
  readonly maxOldSpaceSizeMb: number;
  readonly bundle: string;
}

test("sweep memory: splitProject() on the held-out app's release build stays under the committed peak-RSS budget", (t) => {
  if (!requireSweep(t)) return;
  if (!existsSync(HBC)) {
    t.skip(`${HBC} not present -- run this fixture's fetch.sh first (INCONCLUSIVE, not a failure)`);
    return;
  }
  const budget = JSON.parse(readFileSync(BUDGET_PATH, "utf8")) as Budget;
  assert.equal(budget.bundle, "react-navigation-example.hbc", "budget file must name the exact bundle it was measured on");

  const r = spawnSync(process.execPath, [`--max-old-space-size=${budget.maxOldSpaceSizeMb}`, CHILD, HBC], { encoding: "utf8" });
  assert.equal(r.status, 0, `peak-rss-child failed: ${r.stderr}`);
  const out = JSON.parse(r.stdout) as { maxRssKb: number; fileCount: number };
  assert.ok(out.fileCount > 0, "split produced no files");

  // The load average is printed with every run, pass or fail, because this
  // budget was measured on an idle box and peak RSS rises under memory
  // pressure: a failure on a loaded box is far more likely to be contention
  // than a regression, and the reader should not have to guess which. The
  // Mac measured ~1.22 GB for this same bundle at load ~50 while an idle box
  // measured ~0.95 GB, which is over this budget -- so if you see a failure,
  // check this number before believing it.
  const load = loadavg().map((n) => n.toFixed(2)).join(" ");
  t.diagnostic(`peak RSS ${out.maxRssKb} kB (budget ${budget.rssKbBudget} kB, --max-old-space-size=${budget.maxOldSpaceSizeMb}, loadavg ${load})`);
  assert.ok(
    out.maxRssKb <= budget.rssKbBudget,
    `peak RSS ${out.maxRssKb} kB exceeds the committed budget ${budget.rssKbBudget} kB ` +
      `(${BUDGET_PATH}) -- this is either a real memory regression (fix it) or the budget needs re-measuring ` +
      `on a quiet box and raising with the owner's approval (never just to make this pass)`,
  );
});
