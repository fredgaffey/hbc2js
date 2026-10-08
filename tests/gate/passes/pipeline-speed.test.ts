// The pass pipeline was ~250x slower than the
// baseline on a large bundle (`decompile` of rn-template: 726 ms with passes
// off, >180 s with them on). Root cause: `fn-naming` renamed one `_fnN` per
// driver iteration and re-classified every candidate — each with whole-body
// walks — after every splice, O(K²·B) per function (fn#0 of rn-template has
// K=439 module factories over a 6 MB body). Secondary terms: `expr-rebuild`'s
// whole-body `identUses` per candidate per iteration, `label-clean`'s
// whole-tree `hasGeneratorDispatch` per node per iteration, and both stage-B
// checkers' `JSON.stringify` of every prefix statement per check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { timeScale, loadTag, tooBusyForTiming, withPerfLock, cpuMs } from "../../support/tiers.ts";
import { decompile, decompileTree } from "../../../src/decompile.ts";
import type { Stmt } from "../../../src/emit/ast.ts";
import { id, lit } from "../../../src/emit/ast.ts";
import { applyAstPasses } from "../../../src/passes/ast.ts";
import { fnNaming } from "../../../src/passes/fn-naming/index.ts";
import { match } from "../../../src/passes/fn-naming/match.ts";
import { exprRebuild } from "../../../src/passes/expr-rebuild/index.ts";
import type { ModuleView } from "../../../src/passes/tree.ts";
import type { Pass, PassContext } from "../../../src/passes/types.ts";

// ---------------------------------------------------------------------------
// fn-naming: one match carries every rename (the P-1 root cause).
// ---------------------------------------------------------------------------

function fakeModule(names: readonly string[]): ModuleView {
  return {
    functionCount: names.length,
    functionName: (index: number): string => names[index] ?? "",
    isGlobalFunction: (index: number): boolean => index === 0,
    envSlotAccesses: (): readonly { readonly functionIndex: number; readonly offset: number }[] => [],
    depsVerdict: (): null => null,
  };
}

function baseCtx(module: ModuleView): Omit<PassContext, "applied" | "structured" | "parentOf" | "fnBody"> {
  return {
    analysis: null as unknown as PassContext["analysis"],
    functionIndex: 0,
    cfg: {} as PassContext["cfg"],
    hbcVersion: 94,
    layoutClass: "hbc94" as PassContext["layoutClass"],
    diagnostic: () => {},
    module,
  };
}

/** A global-function-shaped body: `K` module factories `_fn1.._fnK`, each a
 *  `func` statement with a small body that also references itself (the
 *  recursive self-reference `rewrite` must follow into the nested body), and
 *  one `__d(_fnN, N)` call per factory — the shape hermesc gives a React
 *  Native bundle's top level. */
function bundleShapedBody(k: number): { readonly body: readonly Stmt[]; readonly names: readonly string[] } {
  const names: string[] = ["global"];
  const body: Stmt[] = [];
  for (let n = 1; n <= k; n++) {
    names.push(`module${n}`);
    body.push({
      k: "func",
      name: `_fn${n}`,
      params: [{ name: "g" }, { name: "r" }],
      body: [
        { k: "decl", kind: "let", names: ["r0", "r1"] },
        { k: "expr", expr: { k: "assign", target: id("r0"), value: { k: "call", callee: id("r"), args: [lit(String(n))] } } },
        { k: "expr", expr: { k: "assign", target: id("r1"), value: { k: "member", obj: id("r0"), prop: lit("default"), computed: false } } },
        { k: "if", test: { k: "bin", op: "===", left: id("r1"), right: lit("undefined") }, then: [{ k: "return", arg: { k: "call", callee: id(`_fn${n}`), args: [id("g"), id("r")] } }], else: [] },
        { k: "return", arg: id("r1") },
      ],
    });
    body.push({ k: "expr", expr: { k: "call", callee: id("__d"), args: [id(`_fn${n}`), lit(String(n))] } });
  }
  return { body, names };
}

test("P-1: one fn-naming match carries every qualifying rename in the root list, not just the first", () => {
  const { body, names } = bundleShapedBody(5);
  const module = fakeModule(names);
  const ctx: PassContext = { ...baseCtx(module), applied: [], fnBody: body };
  const m = match(body, ctx);
  assert.ok(m !== null);
  assert.deepEqual(
    m.data.renames.map((r) => [r.n, r.from, r.to]),
    [
      [1, "_fn1", "module1"],
      [2, "_fn2", "module2"],
      [3, "_fn3", "module3"],
      [4, "_fn4", "module4"],
      [5, "_fn5", "module5"],
    ],
  );
  assert.equal(m.at.offset, 0, "the site offset is the first renamed statement");
});

test("P-1: fn-naming on a global-function-shaped body with 600 module factories is one applied site and finishes in linear time", () => {
  const { body, names } = bundleShapedBody(600);
  const module = fakeModule(names);
  const t0 = performance.now();
  const r = applyAstPasses(body, [fnNaming as Pass<readonly Stmt[]>], baseCtx(module));
  const ms = performance.now() - t0;
  assert.equal(r.abandoned.length, 0, JSON.stringify(r.abandoned.slice(0, 3)));
  assert.equal(r.applied.length, 1, "the whole batch is one site");
  const renamed = r.body.filter((s) => s.k === "func" && /^module\d+$/.test(s.name)).length;
  assert.equal(renamed, 600);
  assert.equal(JSON.stringify(r.body).includes("_fn"), false, "no _fnN reference survives, including the recursive self-references");
  // Before the fix this shape took O(K²·B): 600 driver iterations, each
  // re-classifying 600 candidates with two whole-body walks apiece, plus a
  // whole-body print per check — well over a minute. The bound is loose on
  // purpose (CI runners are slow); it is the order of magnitude that matters.
  const budget = 3000 * timeScale();
  assert.ok(ms < budget, `fn-naming took ${ms.toFixed(0)} ms on 600 factories (budget ${budget} ms, ${loadTag()})`);
});

/** `K` independent `rN = <pure-ish call>; use(rN);` pairs at the top level —
 *  the shape `expr-rebuild`'s R1a rule folds (single write, single read,
 *  immediately adjacent, `rN` dead after). Each fold's own forward scan is
 *  O(1) (the read sits right next to the store); the only way this could
 *  cost more than O(K) total is an eager whole-list rebuild per site.
 *
 *  Cycles through a small, fixed register alphabet (`REGS`) rather than a
 *  fresh name per candidate: a real Hermes register file is small and
 *  linear-scan-allocated, so a module-root function's thousands of
 *  `rN = …; …; __d(rN, …)` sites reuse the same handful of register names
 *  over and over (module N+`REGS`'s store is the next mention of the name
 *  module N used) — every `nextRelevant` search this shape triggers is
 *  short-distance by construction, the representative case, not the
 *  pathological "prove the name never recurs, scan to the true end" one a
 *  globally-unique name per site would be. */
const REGS = 8;
function foldCandidateRootBody(k: number): readonly Stmt[] {
  const body: Stmt[] = [];
  for (let n = 0; n < k; n++) {
    const reg = `r${n % REGS}`;
    body.push({ k: "expr", expr: { k: "assign", target: id(reg), value: { k: "call", callee: id("source"), args: [lit(String(n))] } } });
    body.push({ k: "expr", expr: { k: "call", callee: id("use"), args: [id(reg)] } });
  }
  return body;
}

test("expr-rebuild on a module-root-shaped list of 5,000 fold candidates finishes within a fixed CPU budget, not O(sites^2)", (t) => {
  const module = fakeModule(["global"]);
  const body = foldCandidateRootBody(5000);
  const ctx = baseCtx(module);
  // Locked (docs/PERF-TESTS.md "in-run vs ambient contention"): this is a
  // multi-second CPU-bound run in its own right, and it is one of the
  // "sibling perf files" the P-1 ratio test below is locked against.
  const on = withPerfLock(
    () =>
      cpuMs(() => {
        const r = applyAstPasses(body, [exprRebuild as unknown as Pass<readonly Stmt[]>], ctx);
        assert.equal(r.abandoned.length, 0, JSON.stringify(r.abandoned.slice(0, 3)));
        assert.equal(r.applied.length, 5000, "every independent fold site applies");
        assert.equal(JSON.stringify(r.body).includes('"k":"assign"'), false, "no folded store survives");
      }),
    t,
  );
  const budget = 15_000 * timeScale();
  assert.ok(on < budget, `expr-rebuild on 5,000 fold candidates took ${on.toFixed(0)} CPU ms (budget ${budget} ms, ${loadTag()})`);
});

// ---------------------------------------------------------------------------
// The pipeline ratio on the committed bundle.
// ---------------------------------------------------------------------------

// Tier-gated AND locked (docs/PERF-TESTS.md "in-run vs ambient contention"):
// this ratio was believed unconditional (common-mode contention on `on`/
// `off`, two measurements of the same process moments apart, mostly
// cancelling) until a coordinator-reported run refuted that at only 1-min
// load 9.2 running three perf files together (passed 5/5 alone at load
// 10.55 -- the load number barely moved, the sibling contention did).
// `withPerfLock` (below) removes contention from this repo's OWN perf-heavy
// sibling files sharing the box's cores at the same moment, and measurably
// helps -- but reproducing the same three-file run 5x in a row with the
// lock in place still failed twice, ratio landing at 12.0-12.8x (budget
// 12x) at 1-min load 11-14, `off` inflated ~40-60% and `on` ~10-40% versus
// an uncontended baseline. That is NOT preemption (a per-process CPU-time/
// wall-clock signal was tried and rejected -- see `withPerfLock`'s doc
// comment) and it is NOT solely this repo's sibling files either, since the
// same asymmetric inflation still occurs from ANY concurrently-heavy
// process on the box (this Mac's ambient load 11-14 that night came from
// unrelated agent sessions, not from a `node --test` sibling): running two
// memory/cache-heavy processes on the same physical machine slows both down
// via shared L3/memory-bandwidth contention with no preemption at all, and
// because `off` (~600ms) and `on` (~9s) are such different durations, a
// contention burst is far more likely to land inside the long `on` window
// than the short `off` window, biasing the ratio up with no code regression.
// Making the ratio itself reliable under that would need instrumenting the
// pass pipeline's own operation counts (out of scope -- see the report);
// the honest fix left is the coordinator's least-preferred option, chosen
// because the alternative is exactly the "cries wolf" failure mode this
// file exists to avoid. Gated on the same "1-min load > 8" threshold as
// `tests/gate/parallel/analysis-timing.test.ts` (reused, not invented) --
// `withPerfLock` still matters because the 1-min load average is a lagging
// 60s window that can read low while this repo's own sibling files (a
// narrower, more frequent case than general ambient load) are mid-burst.
test("P-1: on rn-template, decompiling with every pass on costs at most 12x passes-off (was >250x)", { skip: tooBusyForTiming() }, (t) => {
  const bytes = new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc")));
  const time = (passesOn: boolean): number =>
    cpuMs(() => {
      const r = decompile(bytes, { passes: passesOn ? {} : { none: true }, analysis: { strictEnv: false }, verify: false, resolveV98Ambiguity: true });
      assert.equal(r.module.functions.length, 4199);
    });
  // off, on, off: the second `off` has the JIT as warm as `on` had it, so
  // taking the faster `off` never flatters the ratio. Locked (see above)
  // so this decompile's own timed window is never diluted by a sibling
  // perf-test file's simultaneous heavy work.
  const { off1, on, off2 } = withPerfLock(() => {
    const off1 = time(false);
    const on = time(true);
    const off2 = time(false);
    return { off1, on, off2 };
  }, t);
  const off = Math.min(off1, off2);
  const ratio = on / off;
  // Measured 2026-08-31 (M2 Mac, alone): off ≈ 560 ms, on ≈ 3.1 s, ratio ≈ 5.5.
  // Before the fix `on` did not finish inside 180 s (>250x). 12x leaves room
  // for noise on a shared runner without letting a quadratic term back in.
  //
  // CI red-run 2026-09-04 (GitHub Actions macos-latest, node 22.18): ratio
  // 12.3, off by a hair. Root cause is scheduling noise on a shared vCPU
  // runner inflating the single `on` sample (only `off` gets a worst-of-two)
  // — not a real regression (250x is 20x further out than even this widened
  // bound). HBC2JS_TIME_SCALE (set by ci.yml for exactly this kind of
  // runner slop) scales the bound too, not just the absolute budget below;
  // sqrt keeps the widening sub-linear so a real quadratic-term
  // regression still trips this on CI.
  const ratioBound = 12 * Math.sqrt(timeScale());
  assert.ok(
    ratio <= ratioBound,
    `passes-on/passes-off CPU ratio ${ratio.toFixed(1)} (on ${on.toFixed(0)} ms, off ${off.toFixed(0)} ms) exceeds ${ratioBound.toFixed(1)}x (${loadTag()})`,
  );
  // The absolute budget is a different claim ("this decompile finishes in a
  // sane amount of CPU, not just a sane multiple of an equally-slow
  // baseline"), but it fails the exact same way under contention, so it is
  // gated by the same `{ skip: tooBusyForTiming }` above rather than a
  // second, separate check.
  const absolute = 30_000 * timeScale();
  assert.ok(on < absolute, `passes-on decompile took ${on.toFixed(0)} CPU ms (budget ${absolute} ms, ${loadTag()})`);
});

// `tests/fixtures/bundles/**` (not `tests/fixtures/constructs/**`, so this is
// not the shared-fixture whole-output golden `the consolidation notes` §B
// item 7 rules out — this is one bundle's own perf regression guard, the
// same file already decompiles it above for the ratio test) — a hash pins
// the passes-on rn-template output byte-for-byte so a future change to the
// `check.ts`/`expressionOnlyCheck` bounded-region math (superlinear-pass
// row part 2) cannot silently change semantics while still passing the
// speed budgets above. Verified by hand for this change (`docs/BUGS.md`):
// stashing the `registerUseDelta` rewrite and re-hashing this same bundle,
// plus three `tests/fixtures/constructs/**` fixtures (01-if-else-chain,
// 04-for-loop-basic, 23-generator-basic, all v94, passes on) gave the exact
// same hash before and after.
//
// Pin moved 2026-09-08 at the `finally-dedup` landing (spec 30 design B,
// agent/finally-dedup-2). Old hash 6c2f2dbe..., new hash 35bb93de.... Reviewed
// before/after diff: a removed report
// -- 12 lines at exactly the three folded sites (fn#446, fn#2074, fn#3177):
// each `try` gains its `finalizer=`/`copies=` annotation, nothing else moves.
test("P-1/part-2: rn-template passes-on output hash is unchanged by the check.ts register-delta rewrite", () => {
  const bytes = new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc")));
  const text = decompileTree(bytes, { passes: {}, analysis: { strictEnv: false }, verify: false, resolveV98Ambiguity: true });
  const hash = createHash("sha256").update(text).digest("hex");
  assert.equal(hash, "35bb93de5e562e7f93dfa134dc0dbb41e67a33b027e9842d31828486a4e16ab2");
});
