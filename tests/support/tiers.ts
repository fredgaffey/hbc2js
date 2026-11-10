// docs/specs/00-project-skeleton.md §2.1 — D13 gate/sweep tier selection from env.
// A sweep test file starts with `requireSweep(t)` so a bare `npm test` never spends
// minutes on it.
import type { TestContext } from "node:test";
import { cpus, loadavg, tmpdir } from "node:os";
import { openSync, closeSync, writeSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";

export type Tier = "gate" | "sweep" | "all";

export function currentTier(): Tier {
  const v = process.env["HBC2JS_TIER"];
  if (v === "sweep" || v === "all") return v;
  return "gate";
}

/** Call at the top of a sweep-tier test body. Skips (does not fail) when the tier
 *  isn't sweep/all, so `HBC2JS_TIER` unset means no sweep file executes a body. */
export function requireSweep(t: TestContext): boolean {
  const tier = currentTier();
  if (tier !== "sweep" && tier !== "all") {
    t.skip(`HBC2JS_TIER=${tier}: sweep tier not requested`);
    return false;
  }
  return true;
}

export function requireOracles(): boolean {
  return process.env["HBC2JS_REQUIRE_ORACLES"] === "1";
}

/** Multiplier for wall-clock/timeout budgets in perf-sensitive tests.
 *  Default 1 (unscaled); CI's `ci.yml` sets `HBC2JS_TIME_SCALE=2.5` because
 *  shared runners (and slow-per-core-but-many-cores boxes generally) don't
 *  reach the throughput a fast dev machine gets even at the same core
 *  count. Any non-positive or unparsable value falls back to 1 rather than
 *  silently shrinking a budget to 0. */
export function timeScale(): number {
  const raw = process.env["HBC2JS_TIME_SCALE"];
  if (raw === undefined) return 1;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** The 1-minute load average, formatted for a diagnostic or assertion
 *  message. Every remaining timing-based assertion in the perf-test suite
 *  prints this next to its measurement, so a red run is triageable at a
 *  glance without re-running anything (docs/PERF-TESTS.md). */
export function loadTag(): string {
  return `load ${(loadavg()[0] ?? 0).toFixed(2)}`;
}

/** Samples the 1-min load average every `intervalMs` while a timed region
 *  runs. `stop()` returns the peak seen (start, periodic, end). Pass it to
 *  `tooBusyForTiming(.., peak)` AFTER the measured work. The timer is
 *  unref'd so it never keeps the process alive. */
export function startLoadMonitor(intervalMs = 2000): { stop(): number } {
  let peak = loadavg()[0] ?? 0;
  const tick = () => {
    peak = Math.max(peak, loadavg()[0] ?? 0);
  };
  const h = setInterval(tick, intervalMs);
  h.unref();
  return {
    stop() {
      clearInterval(h);
      tick();
      return peak;
    },
  };
}

/** Coarse load gate for a perf test whose real claim is irreducibly about
 *  wall-clock or CPU time: too few cores, or a busy shared box, makes any
 *  timing measurement meaningless. First defined for
 *  `tests/gate/parallel/analysis-timing.test.ts` ("1-min load > 8"); every
 *  other perf-sensitive gate test that cannot be reformulated as a counted
 *  invariant reuses this exact threshold rather than inventing its own.
 *  Returns a skip reason string, or `false` when the box is quiet enough to
 *  trust the measurement. Use as `{ skip: tooBusyForTiming() }` on `test()`,
 *  or call directly to gate a single assertion inside a larger test that
 *  also makes an unconditional (load-tolerant) claim. */
export function tooBusyForTiming(minCores = 4, maxLoad = 8, observedMaxLoad = 0): string | false {
  if (cpus().length < minCores) return `needs >= ${minCores} cores, have ${cpus().length}`;
  // `observedMaxLoad` is the peak from a LoadMonitor spanning the measured
  // interval: the 1-min average lags a burst, and a long test can start
  // quiet and end loaded (or the reverse), so judge by the worst sample.
  const load = Math.max(loadavg()[0] ?? 0, observedMaxLoad);
  // HBC2JS_PERF_MAX_LOAD overrides the threshold (e.g. to prove an assertion
  // is live on a box that is never quiet; see docs/PERF-TESTS.md).
  const envMax = Number(process.env["HBC2JS_PERF_MAX_LOAD"]);
  if (Number.isFinite(envMax) && envMax > 0) maxLoad = envMax;
  if (load > maxLoad) return `1-min load ${load.toFixed(1)} > ${maxLoad}`;
  return false;
}

/**
 * `docs/PERF-TESTS.md` "in-run vs ambient contention" — the 1-minute load
 * average is a lagging, whole-box, 60-second rolling window. It cannot see
 * `node --test`'s OWN file-level parallelism: several perf-heavy test
 * files, each a separate OS process, all started within the same
 * invocation and competing for the same handful of cores for their own
 * multi-second lifetimes. That competition can be severe even when the
 * 1-min load average reads a merely-elevated single digit (observed: the
 * P-1 ratio test failed at 1-min load 9.2 running three perf files
 * together, vs. a clean pass at load 10.55 running one of those files
 * alone — the load number barely moved, but the contention this process
 * actually experienced disappeared).
 *
 * A per-process self-referential signal (this process's own CPU-time vs.
 * wall-clock during the timed window) was tried and rejected: measured on
 * this Mac, a single-threaded synchronous `decompile()` call routinely
 * reported `cpuMs > wallMs` (efficiency 1.4-1.7) even when running ALONE
 * with no sibling contention at all, because `process.cpuUsage()` is
 * `getrusage(RUSAGE_SELF)` — it sums CPU time across every thread in the
 * process, including V8's own background GC and compilation threads, not
 * just the thread that called `decompile()`. That baseline noise is large
 * enough to swamp any signal preemption would add, so it is not a usable
 * preemption detector for this workload; a bounded retry built on it
 * reported every attempt "clean" and provided zero protection (see
 * `docs/PERF-TESTS.md`'s history note for the reproduction).
 *
 * `withPerfLock` removes the contention instead of trying to detect it:
 * an advisory, cross-process, whole-box lock file that only one of this
 * repo's CPU-heavy perf-test timed regions may hold at a time. It does
 * NOT depend on core count, thread accounting, or a lagging rolling
 * average — two processes literally cannot run their locked sections
 * concurrently, so a real regression's CPU-ms is never diluted by, nor
 * inflated by, a sibling's simultaneous heavy work. Cost: the locked
 * regions across every file that uses this lock effectively serialise
 * against each other (but not against anything else in the gate), which
 * is the correct trade for a test whose whole job is measuring absolute
 * CPU cost.
 */
const PERF_LOCK_PATH = join(tmpdir(), "hbc2js-perf.lock");
/** Long enough for this repo's heaviest locked cycle (the sweep-tier
 *  pipeline-speed test, ~76s wall on a quiet box, all 4 bundle variants)
 *  with real headroom; short enough that a killed/crashed holder cannot
 *  wedge every future run for more than a few minutes. */
const PERF_LOCK_STALE_MS = 5 * 60_000;
const PERF_LOCK_GIVE_UP_MS = 10 * 60_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquirePerfLock(): { readonly waitedMs: number } {
  const start = Date.now();
  for (;;) {
    try {
      const fd = openSync(PERF_LOCK_PATH, "wx");
      writeSync(fd, `${process.pid} ${new Date().toISOString()}`);
      closeSync(fd);
      return { waitedMs: Date.now() - start };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(PERF_LOCK_PATH).mtimeMs > PERF_LOCK_STALE_MS) unlinkSync(PERF_LOCK_PATH);
      } catch {
        // lock vanished between the stat and the unlink, or never existed
        // by the time we looked -- either way, just retry the create.
      }
      if (Date.now() - start > PERF_LOCK_GIVE_UP_MS) {
        throw new Error(`withPerfLock: gave up waiting for ${PERF_LOCK_PATH} after ${PERF_LOCK_GIVE_UP_MS}ms`);
      }
      sleepSync(200);
    }
  }
}

/** Run `f` while holding the shared perf lock (see the block comment
 *  above); releases it in a `finally` so a thrown assertion still frees
 *  the lock for the next file. `t`, if given, gets a diagnostic when this
 *  call actually had to wait (a quiet box never does). */
export function withPerfLock<T>(f: () => T, t?: TestContext): T {
  const { waitedMs } = acquirePerfLock();
  if (t && waitedMs > 50) t.diagnostic(`waited ${waitedMs.toFixed(0)}ms for the shared perf lock (${loadTag()})`);
  try {
    return f();
  } finally {
    try {
      unlinkSync(PERF_LOCK_PATH);
    } catch {
      // already gone (e.g. reclaimed as stale by another process) -- fine.
    }
  }
}

/** CPU milliseconds `f` spent (user+system, `process.cpuUsage()`). Shared
 *  here because every locked perf test uses the identical measurement. */
export function cpuMs(f: () => void): number {
  const t0 = process.cpuUsage();
  f();
  const d = process.cpuUsage(t0);
  return (d.user + d.system) / 1000;
}
