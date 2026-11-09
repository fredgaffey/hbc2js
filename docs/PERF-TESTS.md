# Performance-sensitive tests: what's timed, and why it's trustworthy

This repo runs its test suite on shared, often-loaded boxes (a build node may host several fuzz
campaigns and gates at once, and a developer machine runs several
sessions at once). A handful of tests measure wall-clock or CPU time
as part of their real claim, and every one of them is a re-run risk: the
same assertion that catches a genuine O(n^2) regression can also fail
because the box was busy, with nothing wrong in the code. Six real failures
across two machines prompted this pass. This document records what each timing-sensitive test's *actual*
claim is, which of three mechanisms it uses, and the rule for adding a new
one.

## The mechanisms, in order of preference

1. **Counted invariant.** Reformulate the claim as something you count
   rather than time — an operation count, a tick count, an allocation
   count, an `assert.equal(x, 0)`. This is immune to load by construction:
   the count doesn't change because the box is busy. Preferred wherever
   the claim admits it.
2. **Remove the contention, don't detect it.** If several of this repo's
   OWN perf-heavy test files can run concurrently (they're separate
   processes under `node --test`'s file-level parallelism) and that
   concurrency is itself what corrupts a measurement, the most direct fix
   is to stop them competing at all: `withPerfLock()` in
   `tests/support/tiers.ts` is an advisory cross-process lock so only one
   locked timed region runs on the whole box at a time. This is additive to
   (3) below, not a replacement for it — see "in-run vs ambient contention".
3. **Tier-gate to a quiet box.** When the claim is irreducibly about time,
   skip (never fail) on a busy box, using the shared `tooBusyForTiming()`
   guard in `tests/support/tiers.ts` (1-min load average > 8, or fewer than
   4 cores) — the exact threshold `tests/gate/parallel/analysis-timing.test.ts`
   established first. A skip with a clear reason beats a flake; a test that
   skips so often it never runs is worthless, so each test below says how
   often it's expected to skip and where the claim still gets checked.
4. **Loosen the budget.** Last resort, only with a measured justification,
   never just to silence a flake — that removes the guard the budget exists
   for.

Every remaining timing assertion prints the 1-min load average
(`loadTag()` from `tests/support/tiers.ts`) next to its measurement, pass or
fail, so a red run is triageable without re-running anything — the same
practice `tests/sweep/decompile/peak-memory-budget.test.ts` already uses
for its RSS budget.

## In-run vs ambient contention (read this before touching pipeline-speed.test.ts)

The 1-minute load average is a lagging, whole-box, 60-second rolling
window. It is the right signal for "this box is generally busy right now,"
but a first pass at this file (which kept the P-1 ratio unconditional,
reasoning that two same-process measurements moments apart cancel common-
mode contention) missed two things it does not cover:

- **`node --test`'s own file-level parallelism.** Several perf-heavy test
  files, each its own OS process, can start within the same invocation and
  compete for the same handful of cores for their own multi-second
  lifetimes. This can be severe even when the 1-min load average reads a
  merely-elevated single digit: a reported run showed the P-1
  ratio failing at 1-min load 9.2 running three perf files together, while
  the SAME test passed 5/5 at load 10.55 run alone — the load number barely
  moved, but the contention this process actually experienced disappeared
  entirely.
- **Ordinary ambient contention from ANY concurrently-heavy process**,
  `node --test` sibling or not (this repo's own investigation happened on a
  loaded machine shared with several unrelated sessions). Two
  memory/cache-heavy processes slow each other down via shared L3-cache/
  memory-bandwidth contention even with zero preemption — the CPU is
  running the whole time, it is just doing more cache-miss work per
  instruction, which is real extra CPU-ms, not wall-clock wait. A ratio
  test whose two arms have very different durations (P-1's `off` ~600ms vs
  `on` ~9s) is exposed further: a contention burst is far more likely to
  land inside the long arm than the short one, biasing the ratio up with no
  code regression at all.

A **per-process self-referential signal was tried and rejected** as a
detector for either case: `process.cpuUsage()` is `getrusage(RUSAGE_SELF)`,
which sums CPU time across every thread in the process, including V8's own
background GC and JIT-compilation threads — not just the thread that
called `decompile()`. Measured on a macOS machine, a single-threaded synchronous
`decompile()` call routinely reported `cpuMs > wallMs` ("efficiency"
1.4-1.7) with zero sibling contention, simply because those background
threads are real concurrent work happening inside the same process. A
bounded retry built on that signal reported every attempt "clean" and
provided zero actual protection — worse than doing nothing, because it
looks like a fix while catching nothing. A genuine per-process contention
signal would need something outside `process.cpuUsage()` entirely (e.g. a
canary worker thread ticking a shared counter, calibrated against a
known-idle baseline); nobody has built that here, and it was not attempted
given the scope of this pass.

**What's landed instead:** `withPerfLock()` removes the first case (this
repo's own sibling perf files) by construction — two locked regions
literally cannot run at the same time, no detection needed. Reproducing the
reported three-file run 5 times with the lock in place still failed twice
(ratio 12.0-12.8x against a 12x budget, at 1-min load 11-14): the lock
measurably reduced the overshoot (13.3-13.4x unlocked vs 12.0-12.8x locked,
same repro) but did not fully close the gap, because the second case
(ambient contention from anything else on the box) is still real and still
biases a duration-asymmetric ratio. The backstop for that is the same
`tooBusyForTiming()` skip used everywhere else in this file — reused, not
reinvented. Making the ratio itself fully immune to this would mean
instrumenting the pass pipeline's own operation/allocation counts so the
"12x" claim is counted rather than timed at all; that is real future work,
out of scope for a test-robustness pass that does not touch `src/passes/**`
to make its own tests pass.

## Per-test table

| Test | Real claim | Mechanism | Notes |
|---|---|---|---|
| `tests/ui-server/search-perf.test.ts` "keeps answering other routes while a search is in flight" | The ui-server's single thread doesn't block for the whole duration of a bundle-wide search. | **Counted.** A `setInterval(5ms)` ticks while the probe request is awaited; `ticks > 0` can only hold if the search yielded the event loop, regardless of how loaded the box is. Replaced a hard `ms < 200` bound (failed at 261ms under machine load 280). The `ms` value is now a diagnostic only. |  |
| same file, "GET /api/template-injections answers off the critical path" | Same claim, for the injection-scan route. | **Counted**, same tick mechanism, only enforced when the scan is still in flight (`!done`) — otherwise there's nothing to prove blocking against. | |
| `tests/gate/passes/pipeline-speed.test.ts` "P-1: ... at most 12x passes-off" | (a) passes-on is never a wild multiple of passes-off (catches the O(K^2) regression); (b) passes-on finishes in a sane absolute amount of CPU. | **Locked AND tier-gated.** Whole test skipped via `{ skip: tooBusyForTiming() }`; the off/on/off cycle inside also runs under `withPerfLock()`. Originally shipped with (a) unconditional and (b) tier-gated, on the theory that a same-process back-to-back ratio cancels common-mode contention; a reported run refuted that ((a) failed at 1-min load 9.2 running three perf files together). See "in-run vs ambient contention" above for the full history, including the rejected per-process CPU/wall signal. | Expect this whole test to skip whenever 1-min load > 8 — on a build node inside a full parallel gate that is common. The lock is still worth keeping: it measurably reduces the overshoot when load happens to read just under 8 while a sibling perf file is mid-burst (a case the load gate alone cannot see). Runs and passes on every quiet/solo run; verified directly at 1-min load 7.28-7.61. |
| `tests/sweep/passes/pipeline-speed.test.ts` (4 bundle variants) | Same claim, sweep-tier companion (`HBC2JS_TIER=sweep`). | Same locked-and-tier-gated shape, checked once via `t.skip()` (node:test's static `skip` option can't see `requireSweep`'s own tier check first) rather than per-assertion. | Verified passing on a quiet build node (load 0.75, all 4 variants, ~76s) and skipping cleanly on a loaded box. |
| `tests/gate/passes/pipeline-speed.test.ts` "600 module factories... finishes in linear time" | Absolute CPU-ms budget pinning a specific historical O(K^2) fix. | **Unchanged, timing** — cheap (tens of ms), not reported failing. Load printed in the message. | If it starts flaking, it's a much smaller ask to lock/tier-gate than P-1 was. |
| same file, "5,000 fold candidates... fixed CPU budget" | Absolute CPU-ms budget, same history. | **Locked** (multi-second, a genuine sibling to P-1) but NOT tier-gated — its own comment already documents a measured 15s budget with headroom over an observed 9.3s-under-contention reading, so the existing slack absorbs what the lock doesn't. | |
| `tests/gate/passes/expr-rebuild-perf.test.ts` "per-site cost scales close to linearly", "expressionOnlyCheck's read-before-def half costs a fraction...", "classify layer costs the same per site...", "classifySite's scan... costs a fraction..." | Self-calibrating ratios: numerator and denominator measured back-to-back in the same process on the same list, so common-mode contention cancels by construction. | **Locked, unconditional otherwise.** Not reported failing even at load ~20-25; `withPerfLock()` added defensively since these are P-1's own siblings, at essentially no cost (a quiet box never waits). Load printed in each message. | |
| same file, "writer and checker cost less than the whole-list rebuild-and-compare" | Same self-calibrating-ratio shape, plus `bestOf(5)` (best-of-N) on top. | **Locked AND tier-gated.** Already had the strongest available mitigation and still failed at load 190 — the file's own `bestOf` doc comment already flags this class of failure as "not enough". `withPerfLock()` added on top (helps the moderate-load case); the ambient-load skip stays as the backstop for load 190-scale whole-box chaos the lock cannot reach. Reformulating further would mean instrumenting allocation/copy counts inside `expr-rebuild/rewrite.ts`/`check.ts` themselves, which this test-only pass does not do. | Skips whenever 1-min load > 8; still runs on every quiet/solo run and is the direct proof for `docs/BUGS.md`'s superlinear-pass row part 4. |
| same file, "classifying every site... grows near-linearly" | Per-site classify cost doesn't grow with N. | **Locked AND tier-gated.** `small`/`large` here are two *independent* `bestOf` measurements, not a single back-to-back pair, so a pause landing in just one of them isn't cancelled the way the ratio tests above are — flaked on a build node at load 52 despite `bestOf(RATIO_REPS)`. | Same threshold, same reasoning as above. |

## Rule for a new performance assertion

1. Ask first whether the claim can be a count (ticks, applied-site count,
   `assert.equal(..., 0)`, a complexity-shape check on N vs 2N/4N). If yes,
   do that — it's immune to load and it's usually a stronger, more direct
   proof of the property than a stopwatch is.
2. If it's genuinely about time, prefer a *self-calibrating ratio*:
   numerator and denominator measured back-to-back in the same process on
   the same input, so common-mode contention cancels. An absolute budget or
   a ratio between two independently-measured runs is much more load-fragile
   — treat those as needing a tier gate from the start. **Do not assume a
   self-calibrating ratio is unconditional just because the theory says
   common-mode contention cancels** — verify it by actually running the new
   test alongside this file's other perf tests a handful of times, not just
   alone; see "in-run vs ambient contention" above for why "alone" can
   silently hide the exact failure mode that matters.
3. If the new test is heavy (multi-second) and lives next to this repo's
   other perf-heavy tests, wrap its timed region in `withPerfLock()` from
   `tests/support/tiers.ts` — cheap on a quiet box (one lock/unlock), and it
   directly removes contention from `node --test`'s own file-level
   parallelism rather than hoping a ratio cancels it.
4. If a timing assertion still cannot be made load-tolerant by (1)-(3), gate
   it with `tooBusyForTiming()` from `tests/support/tiers.ts` — reuse that
   one threshold, don't invent a new one. Do NOT build a per-process
   "am I being preempted" signal on `process.cpuUsage()` — it's already
   been tried here and shown not to work (see above).
5. Print `loadTag()` next to every timing assertion's message, whether it
   passes, fails, or the surrounding test skips.
6. Never raise a budget, and never widen a ratio bound, solely because a run
   under load failed — that's the thing the flake is protecting. A genuine
   budget change needs a measured justification recorded in the test's own
   comment, the same way the existing budgets in this file cite specific
   measured numbers and dates.

## Gate deflake (load-dependent failures under the full parallel gate)

Three tests passed alone but failed intermittently in `npm test` (`node --test`, one process per file, all files at once):

- **Playwright smoke (`tests/gate/ui/e2e-smoke.test.ts`)** spawned the whole 82-spec run inside the parallel batch (~1 min alone, 90-240 s and failing under load). `npm test` / `npm run test:gate` now set `HBC2JS_E2E_DEFER=1` for the parallel batch (the test skips with that reason) and then run `node --test tests/gate/ui/e2e-smoke.test.ts` as a serial stage afterwards, alone on the box. Still in the gate: a red spec fails `npm test`. Running the file directly (no env var) runs the suite inline.
- **`routes.test.ts` segregation settle waits** polled 200 x 20 ms (4 s) for a worker-thread compute; under load that is load, not a hang. Now a 120 s deadline (the loop still exits the instant the compute settles; a genuine hang still fails).
- **`tiers.test.ts` identity run 120 s wall budget** measured 67 s alone vs 165 s under the gate: contention. The wall assertion now follows mechanism 3 (`tooBusyForTiming()`: logged, not enforced, on a busy box); DIVERGENT/ERROR correctness assertions are unconditional.

## Load sampling over the measured interval (2026-11)

Both `tiers.test.ts` (120 s identity budget) and `routes.test.ts` (segregation
warm-up) still failed in full gates at 1-min load 40-85 on 10 cores. The 1-min
average lags bursts and is a single end-of-test sample, so a long test can be
judged "quiet" by a stale reading. `tests/support/tiers.ts` now has
`startLoadMonitor()` (samples `loadavg()[0]` at start, every 2 s, and at stop;
`stop()` returns the peak) and `tooBusyForTiming(minCores, maxLoad, peak)`
takes the max of the peak and the current reading. The tiers test logs
`gate identity load: peak X, busy=...` every run so a miss is diagnosable.
Threshold stays an absolute 1-min load of 8; override with
`HBC2JS_PERF_MAX_LOAD` (proves an assertion is live on a box that is never
quiet). `HBC2JS_PERF_INJECT_MS` adds fake elapsed ms to the tiers run for a
manual red check (`HBC2JS_PERF_MAX_LOAD=100000 HBC2JS_PERF_INJECT_MS=100000`
must fail).

The segregation warm-up test is now a state claim: it waits up to 60 s x
`HBC2JS_TIME_SCALE` for `segregationCached()` (load only delays it) and the
"<1000 ms warmed answer" bound is enforced only when not busy.
