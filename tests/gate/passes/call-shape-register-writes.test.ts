// Perf-register-writes (test-speed profiling, 2026-11-10): R3h's
// `isProvenUndefinedThis` re-walked the whole function body once per call
// site, so a module-root-shaped function with `n` `Reflect.apply` sites cost
// Theta(n^2) node visits (11 s self-time in the name-batch test). The write
// summary is now built once per statement and folded per function body
// (docs/specs/passes/04-call-shape.md section 4, R3h/R3i).
//
// Load-robust: counts node visits of the write walk, never wall time.
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { requireSweep } from "../../support/tiers.ts";
import { analyseModule } from "../../../src/cfg/index.ts";
import { parseForDecompile } from "../../../src/decompile.ts";
import { emitModule } from "../../../src/emit/index.ts";
import { astPassHook, passHook } from "../../../src/passes/index.ts";
import { isRegisterName, stmtLists } from "../../../src/passes/ast.ts";
import type { Expr, Stmt } from "../../../src/emit/ast.ts";
import { id, lit } from "../../../src/emit/ast.ts";
import { applyAstPasses } from "../../../src/passes/ast.ts";
import type { RegisterWriteFacts, RegisterWriteOracle } from "../../../src/passes/call-shape/match.ts";
import { REFERENCE_ORACLE, SUMMARY_ORACLE, collectCandidates, isLocallyUndefinedThis, isProvenUndefinedThis } from "../../../src/passes/call-shape/match.ts";
import { callShape } from "../../../src/passes/call-shape/index.ts";
import { registerWriteWalkStats } from "../../../src/passes/call-shape/match.ts";
import type { ModuleView } from "../../../src/passes/tree.ts";
import type { Pass, PassContext } from "../../../src/passes/types.ts";

function baseCtx(): Omit<PassContext, "applied" | "structured" | "parentOf" | "fnBody"> {
  const module: ModuleView = {
    functionCount: 1,
    functionName: (): string => "global",
    isGlobalFunction: (index: number): boolean => index === 0,
    envSlotAccesses: (): readonly { readonly functionIndex: number; readonly offset: number }[] => [],
    depsVerdict: (): null => null,
  };
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

const member = (obj: Expr, prop: string): Expr => ({ k: "member", obj, prop: lit(prop), computed: false });
const reflectApply = (F: Expr, T: Expr, args: readonly Expr[]): Expr => ({ k: "call", callee: member(id("Reflect"), "apply"), args: [F, T, { k: "array", elements: args }] });

/** `n` R3a sites, each receiver register written `undefined` once, half of
 *  them inside an `if` (so nested lists and spine rebuilds are exercised). */
function moduleRoot(n: number): Stmt[] {
  const body: Stmt[] = [];
  for (let i = 0; i < n; i++) {
    const r = `r${i}`;
    const site: Stmt[] = [
      { k: "expr", expr: { k: "assign", target: id(r), value: lit("undefined") } },
      { k: "expr", expr: { k: "call", callee: id("use"), args: [reflectApply(id("f"), id(r), [lit(String(i))])] } },
    ];
    if (i % 2 === 0) body.push(...site);
    else body.push({ k: "if", test: id("c"), then: site, else: [] });
  }
  return body;
}

function visitsFor(n: number): { visits: number; applied: number } {
  const before = registerWriteWalkStats.nodes;
  const out = applyAstPasses(moduleRoot(n), [callShape as unknown as Pass<readonly Stmt[], unknown>] as never, baseCtx());
  return { visits: registerWriteWalkStats.nodes - before, applied: out.applied.length };
}

test("perf-register-writes: R3h/R3i write-walk node visits grow linearly with call sites in one function", () => {
  const small = visitsFor(100);
  const large = visitsFor(400);
  assert.equal(small.applied, 100);
  assert.equal(large.applied, 400);
  // ~12 object nodes per site; a linear walk visits each statement O(1)
  // times over the whole run. The old per-site whole-body walk is ~n x body.
  console.log(`# visits: 100 sites ${small.visits}, 400 sites ${large.visits}`);
  const perSite = large.visits / 400;
  assert.ok(perSite <= 40, `write walk visited ${large.visits} nodes for 400 sites (${perSite.toFixed(1)}/site; 100 sites: ${small.visits})`);
  assert.ok(large.visits <= 4.5 * small.visits, `4x the sites cost ${(large.visits / small.visits).toFixed(2)}x the visits (linear is ~4x, quadratic ~16x)`);
});

// ---------------------------------------------------------------------------
// Differential: the memoised summary answers exactly as the original
// per-register walk (kept as `REFERENCE_ORACLE`), on real stage-B trees.
// ---------------------------------------------------------------------------

/** Every function body as call-shape sees its sites (call-shape skipped, so
 *  every `Reflect.apply` is still there). */
function bodiesOf(file: string): (readonly Stmt[])[] {
  const { module } = parseForDecompile(new Uint8Array(readFileSync(file)), { resolveV98Ambiguity: true });
  const analysis = analyseModule(module, { strictEnv: true });
  const opts = { skip: ["call-shape"] };
  const hook = astPassHook(analysis, opts);
  const bodies: (readonly Stmt[])[] = [];
  emitModule(analysis, {
    moduleName: "m",
    provenanceComments: false,
    strictEnv: true,
    passes: passHook(analysis, opts),
    astPasses: (fn, cfg) => {
      const out = hook(fn, cfg);
      if (out.fn.k === "func") bodies.push(out.fn.body as readonly Stmt[]);
      return out;
    },
  });
  return bodies;
}

/** Every register name occurring as any string field anywhere in `node`. */
function registerNames(node: unknown, out = new Set<string>()): Set<string> {
  if (node === null || typeof node !== "object") return out;
  for (const v of Array.isArray(node) ? node : Object.values(node)) {
    if (typeof v === "string") {
      if (isRegisterName(v)) out.add(v);
    } else registerNames(v, out);
  }
  return out;
}

/** An opaque write is opaque whatever else the walk saw. */
const norm = (f: RegisterWriteFacts): RegisterWriteFacts => (f.opaque ? { opaque: true, writes: 0, notUndefined: 0 } : f);

interface Tally {
  functions: number;
  regQueries: number;
  sites: number;
  provenR3h: number;
  provenR3i: number;
}

function differential(bodies: readonly (readonly Stmt[])[], where: string, tally: Tally): void {
  for (const body of bodies) {
    tally.functions++;
    for (const reg of registerNames(body)) {
      tally.regQueries++;
      assert.deepEqual(norm(SUMMARY_ORACLE.list(body, reg)), norm(REFERENCE_ORACLE.list(body, reg)), `${where}: whole-body facts for ${reg}`);
    }
    for (const list of stmtLists(body)) {
      for (const c of collectCandidates(list)) {
        if (c.node.k !== "call" || c.node.args.length !== 3) continue;
        const T = c.node.args[1]!;
        const at = { list, stmtIndex: c.stmtIndex };
        tally.sites++;
        const h = isProvenUndefinedThis(T, body);
        const i = isLocallyUndefinedThis(T, at);
        assert.equal(h, isProvenUndefinedThis(T, body, REFERENCE_ORACLE), `${where}: R3h at site ${c.stmtIndex}`);
        assert.equal(i, isLocallyUndefinedThis(T, at, REFERENCE_ORACLE), `${where}: R3i at site ${c.stmtIndex}`);
        if (h) tally.provenR3h++;
        if (i) tally.provenR3i++;
        // The node-level facts R3i reads, for every register the statement names.
        const s = list[c.stmtIndex]!;
        for (const reg of registerNames(s)) {
          assert.deepEqual(norm(SUMMARY_ORACLE.node(s, reg)), norm(REFERENCE_ORACLE.node(s, reg)), `${where}: node facts for ${reg}`);
        }
      }
    }
  }
}

const VERSIONS = [94, 96, 98, 99];

test("perf-register-writes differential: R3h/R3i verdicts and write facts match the original walk on every construct fixture, v94..v99", () => {
  const dir = join(repoRoot(), "tests", "fixtures", "constructs");
  const tally: Tally = { functions: 0, regQueries: 0, sites: 0, provenR3h: 0, provenR3i: 0 };
  for (const fixture of readdirSync(dir).sort()) {
    for (const v of VERSIONS) {
      const file = join(dir, fixture, `v${v}.hbc`);
      if (existsSync(file)) differential(bodiesOf(file), `${fixture} v${v}`, tally);
    }
  }
  console.log(`# constructs: ${JSON.stringify(tally)}`);
  assert.ok(tally.functions >= 700 && tally.sites >= 100 && tally.provenR3h > 0 && tally.provenR3i > 0, JSON.stringify(tally));
});

test("perf-register-writes differential: the same on the rn-template bundle (sweep tier)", (t: TestContext) => {
  if (!requireSweep(t)) return;
  const file = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");
  if (!existsSync(file)) return t.skip("rn-template-0.72/index.android.hbc not present");
  const tally: Tally = { functions: 0, regQueries: 0, sites: 0, provenR3h: 0, provenR3i: 0 };
  differential(bodiesOf(file), "rn-template", tally);
  console.log(`# rn-template: ${JSON.stringify(tally)}`);
  assert.ok(tally.functions >= 1000 && tally.sites > 0, JSON.stringify(tally));
});
