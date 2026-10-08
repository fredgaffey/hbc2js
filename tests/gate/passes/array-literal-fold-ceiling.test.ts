// Definitions this test relies on (see the tool's own header for the full
// argument):
//   - "unfolded new Array( sites" (the denominator): every surviving
//     `rN = new Array(k)`/`NewFastArray` statement (k > 0) the real
//     `array-literal` rung's own fixed point still leaves in place -- the
//     same count a `new Array(` text-grep on the final emitted source
//     would give.
//   - "closes-with-fold": every element the site needs (index 0..k-1)
//     exists as an own-index store, and every element whose value is a
//     bare register read has a definition, found WITHIN the same
//     statement list `array-literal` itself matches over, that is (a) a
//     plain `rX = <pure expression>` (`isPure`, the same purity test
//     `array-literal`'s own `canHoist` uses) and (b) read nowhere else in
//     that list ("single-use") -- i.e. substituting that definition
//     directly into the store's own value, in place, would turn the site
//     into a fully contiguous run with nothing left over.
//   - "undecidable": at least one element's value is a bare register read
//     whose definition this tool's local, list-scoped analysis cannot find
//     at all (defined outside the statement list -- an outer scope, a
//     parameter, or a preceding sibling block) -- genuinely unknown, not
//     folded into either other bucket.
//   - everything else is "blocked": decidably NOT fixed by element-
//     expression folding alone (an index gap/repeat, a self-referencing
//     store, a non-store/non-fold-candidate interleaved statement, a
//     definition that exists locally but is impure or used more than
//     once, or a leftover definition nothing ever consumes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { requireSweep } from "../../support/tiers.ts";
import { measureBundle } from "../../../tools/passes/array-literal-fold-ceiling.ts";
import type { FoldCeilingStats } from "../../../tools/passes/array-literal-fold-ceiling.ts";

const BUNDLE_DIR = join(repoRoot(), "tests", "fixtures", "bundles", "react-navigation-example-0.85.3");

function assertCeiling(stats: FoldCeilingStats, label: string): void {
  assert.equal(stats.total, 926, `${label}: unfolded-site count drifted (was 926)`);
  assert.equal(stats.closesWithFold, 3, `${label}: closes-with-fold count drifted (was 3)`);
  assert.equal(stats.blocked, 892, `${label}: blocked count drifted (was 892)`);
  assert.equal(stats.undecidable, 31, `${label}: undecidable count drifted (was 31)`);
  assert.equal(stats.closesWithFold + stats.blocked + stats.undecidable, stats.total, `${label}: buckets do not sum to the total`);
  // The whole point of I3 step 1: is the ceiling above the 30% threshold
  // step 2 is gated on? On this held-out app, no -- by a wide margin.
  assert.ok(stats.closesWithFold / stats.total < 0.3, `${label}: ceiling ${stats.closesWithFold}/${stats.total} unexpectedly crossed the 30% step-2 threshold`);
}

void test("sweep: array-literal fold-ceiling on react-navigation-example.hbc (RELEASE build)", async (t) => {
  if (!requireSweep(t)) return;
  const path = join(BUNDLE_DIR, "react-navigation-example.hbc");
  if (!existsSync(path)) {
    t.skip("react-navigation-example-0.85.3 not fetched (run tests/fixtures/bundles/react-navigation-example-0.85.3/fetch.sh)");
    return;
  }
  const stats = measureBundle(new Uint8Array(readFileSync(path)), "react-navigation-example.hbc");
  assertCeiling(stats, "react-navigation-example.hbc (release)");
});

void test("sweep: array-literal fold-ceiling on react-navigation-example.debug.hbc (DEBUG build)", async (t) => {
  if (!requireSweep(t)) return;
  const path = join(BUNDLE_DIR, "react-navigation-example.debug.hbc");
  if (!existsSync(path)) {
    t.skip("react-navigation-example-0.85.3 not fetched (run tests/fixtures/bundles/react-navigation-example-0.85.3/fetch.sh)");
    return;
  }
  const stats = measureBundle(new Uint8Array(readFileSync(path)), "react-navigation-example.debug.hbc");
  // Debug build measured identical to release (2026-09-29) -- pinned
  // separately anyway, per this lane's own "always name the bundle file"
  // rule, so a future divergence between the two builds is caught here.
  assertCeiling(stats, "react-navigation-example.debug.hbc (debug)");
});
