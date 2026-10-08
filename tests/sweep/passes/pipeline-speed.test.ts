// Sweep-tier companion to
// tests/gate/passes/pipeline-speed.test.ts: every rn-template variant that is
// present (optimised/noopt × release/debug), decompiled with every pass on,
// must finish inside 30 s (scaled) and within 12x of the passes-off time.
// Before the fix the optimised bundle alone did not finish inside 180 s.
//
// Tier-gated AND locked (docs/PERF-TESTS.md "in-run vs ambient contention"):
// same reasoning as the gate test's identical comment -- the ratio was
// believed unconditional but proved not to be under only moderate (load
// 9-14) contention, whether from a `node --test` sibling perf file or from
// any other concurrently-heavy process on the box. `withPerfLock` removes
// the former; `{ skip: tooBusyForTiming }` (checked once, at runtime, via
// `t.skip`, since node:test's static `skip` option cannot see this file's
// own tier gate first) is the backstop for the latter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { requireSweep, timeScale, loadTag, tooBusyForTiming, withPerfLock, cpuMs } from "../../support/tiers.ts";
import { repoRoot } from "../../support/paths.ts";
import { decompile } from "../../../src/decompile.ts";

test("P-1 sweep: every rn-template variant decompiles with all passes on inside 30 s and 12x of passes-off", (t) => {
  if (!requireSweep(t)) return;
  const busy = tooBusyForTiming();
  if (busy) {
    t.skip(busy);
    return;
  }
  const dir = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72");
  const names = ["index.android.hbc", "index.android.debug.hbc", "index.android.noopt.hbc", "index.android.noopt.debug.hbc"];
  let checked = 0;
  for (const name of names) {
    const path = join(dir, name);
    try {
      statSync(path);
    } catch {
      continue;
    }
    const bytes = new Uint8Array(readFileSync(path));
    // CPU time, not wall-clock: `node --test` runs files in parallel
    // processes, and only CPU time is immune to being starved by them (see
    // the gate test's `cpuMs`).
    const time = (passesOn: boolean): number =>
      cpuMs(() => {
        const r = decompile(bytes, { passes: passesOn ? {} : { none: true }, analysis: { strictEnv: false }, resolveV98Ambiguity: true, moduleName: name });
        assert.ok(r.code.length > 0);
      });
    // Locked per bundle variant (docs/PERF-TESTS.md -- see the gate test's
    // identical comment and `withPerfLock`'s doc in tests/support/tiers.ts).
    const { on, off } = withPerfLock(() => {
      const off1 = time(false);
      const on = time(true);
      const off = Math.min(off1, time(false));
      return { off1, on, off };
    }, t);
    assert.ok(on / off <= 12, `${name}: passes-on/passes-off ratio ${(on / off).toFixed(1)} (on ${on.toFixed(0)} ms, off ${off.toFixed(0)} ms) exceeds 12x (${loadTag()})`);
    const budget = 30_000 * timeScale();
    assert.ok(on < budget, `${name}: passes-on decompile took ${on.toFixed(0)} ms (budget ${budget} ms, ${loadTag()})`);
    checked++;
  }
  assert.ok(checked > 0, "no rn-template bundle was available");
});
