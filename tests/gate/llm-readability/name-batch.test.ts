// tests/gate/llm-readability/name-batch.test.ts -- spec 28 section 9.1 "one
// model call per function, not per register": `NamePassFunctionTarget` and
// `runNamePass`'s function-batch branch, plus the cache-key and coverage-
// counting properties that fall out of it. `name-pass.test.ts` keeps the
// register-form tests unchanged; this file is the function-batch form only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { parseForDecompile } from "../../../src/decompile.ts";
import { analyseModule } from "../../../src/cfg/index.ts";
import { NameService, OverlayStore, regId, shortForm } from "../../../src/name-overlay/index.ts";
import { FakeBackend } from "../../../src/workers/backend.ts";
import type { WorkerJobRequest } from "../../../src/workers/backend.ts";
import { runNamePass, namedCount, isFunctionTarget } from "../../../src/readability/name-pass.ts";
import type { NamePassFunctionTarget, NamePassTarget } from "../../../src/readability/name-pass.ts";
import { cacheKey } from "../../../src/readability/types.ts";
import { bodyFromContext, canonicaliseContext } from "../../../src/workers/backends/haiku.ts";
import { loadSkill } from "../../../src/readability/skills.ts";
import { computeSrcScope } from "../../../src/readability/scope.ts";
import { rawFrameBodies } from "../../../src/name-overlay/frames.ts";
import { listNameable } from "../../../src/artifact/frame-queries.ts";
import type { RenderOptions, RenderResult } from "../../../src/name-overlay/render.ts";

const FIXTURE = "04-for-loop-basic";

// The two slow tests below both need computeSrcScope(rn-template-0.72) (~25s)
// and the second also spawns the CLI (which recomputes it). Compute the scope
// once per process, and start the CLI child at module load so it overlaps the
// in-process work of the first slow test. Both are only awaited inside the tests.
const RN_HBC = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");
let rnScopeMemo: ReturnType<typeof computeSrcScope> | undefined;
function rnScope(): ReturnType<typeof computeSrcScope> {
  rnScopeMemo ??= computeSrcScope(RN_HBC, new Uint8Array(readFileSync(RN_HBC)));
  return rnScopeMemo;
}
interface CliRun { status: number | null; stdout: string; stderr: string }
let onlySrcCli: Promise<CliRun> | undefined;
let onlySrcDir: string | undefined;
function startOnlySrcCli(): Promise<CliRun> {
  if (onlySrcCli !== undefined) return onlySrcCli;
  onlySrcDir = mkdtempSync(join(tmpdir(), "hbc2js-llmfill-only-src-"));
  const child = spawn(process.execPath, [join(repoRoot(), "src", "cli.ts"), "name", "llm-fill", RN_HBC, "--backend", "fake", "--only", "src", "--store", join(onlySrcDir, "store.json"), "--json"]);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  onlySrcCli = new Promise<CliRun>((resolve) => child.once("close", (status) => resolve({ status, stdout, stderr })));
  return onlySrcCli;
}

function analysisFor(name: string): ReturnType<typeof analyseModule> {
  const bytes = new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", name, "v94.hbc")));
  return analyseModule(parseForDecompile(bytes, {}).module, { strictEnv: true });
}

function svc(): NameService {
  return new NameService(analysisFor(FIXTURE), new OverlayStore({ bundle: FIXTURE }));
}

/** A function target over fn 0's regs 9 and 3 (both real, nameable registers
 *  of the fixture's global function -- reused from name-pass.test.ts's own
 *  choices, so the gate is refused/allowed the same way). */
function fnTarget(regs: readonly number[], source = "function f0(){}"): NamePassFunctionTarget {
  const ids = regs.map((r) => regId(0, r));
  return { kind: "suggest-name", fn: 0, regs: ids, context: { fn: 0, targets: ids.map((id) => shortForm(id)), source } };
}

function fnReply(names: readonly { fn: number; reg: number; name: string }[]): string {
  return JSON.stringify({
    names: names.map((n) => ({ bindingId: { fn: n.fn, reg: n.reg }, name: n.name, confidence: "high", evidence: `evidence for ${n.name}` })),
    abstained: names.length === 0,
  });
}

test("runNamePass (function batch): ONE backend call names every requested register of the function", async () => {
  const service = svc();
  const calls: WorkerJobRequest[] = [];
  const backend = new FakeBackend({
    replies: {
      "suggest-name": (req) => {
        calls.push(req);
        return fnReply([
          { fn: 0, reg: 9, name: "loopCount" },
          { fn: 0, reg: 3, name: "accumulator" },
        ]);
      },
    },
  });
  const target = fnTarget([9, 3]);
  const result = await runNamePass([target], { backend, service });

  assert.equal(calls.length, 1, "one function target must make exactly one backend call, however many regs it asks about");
  assert.equal(namedCount(result.outcomes), 2, "the coverage helper counts BOTH written registers, not one per call");
  assert.equal(service.getName(regId(0, 9))?.name, "loopCount");
  assert.equal(service.getName(regId(0, 3))?.name, "accumulator");
  assert.equal(result.droppedUnknownNames, 0);
  assert.equal(result.equiv.verdict, "PASS");
  // Every outcome is reported as a per-register target, whichever call
  // produced it -- callers never see a "function" shaped target.
  for (const o of result.outcomes) assert.equal("bindingId" in o.target, true);
});

test("runNamePass (function batch): a missing reg in the reply is an abstain for that reg, not for the whole function", async () => {
  const service = svc();
  const backend = new FakeBackend({
    replies: { "suggest-name": () => fnReply([{ fn: 0, reg: 9, name: "loopCount" }]) }, // reg 3 never answered
  });
  const target = fnTarget([9, 3]);
  const result = await runNamePass([target], { backend, service });

  assert.equal(namedCount(result.outcomes), 1);
  const byReg = new Map(result.outcomes.map((o) => [o.target.bindingId.kind === "reg" ? o.target.bindingId.reg : -1, o]));
  assert.equal(byReg.get(9)?.written, true);
  assert.equal(byReg.get(3)?.written, false);
  assert.equal(byReg.get(3)?.reason, "abstained");
  assert.equal(service.getName(regId(0, 3)), null);
});

test("runNamePass (function batch): a bindingId outside the requested regs is dropped and counted, never written", async () => {
  const service = svc();
  const backend = new FakeBackend({
    replies: {
      "suggest-name": () =>
        fnReply([
          { fn: 0, reg: 9, name: "loopCount" }, // requested
          { fn: 0, reg: 999, name: "ghost" }, // NOT requested -- unknown/off-target
        ]),
    },
  });
  const target = fnTarget([9]);
  const result = await runNamePass([target], { backend, service });

  assert.equal(namedCount(result.outcomes), 1);
  assert.equal(service.getName(regId(0, 9))?.name, "loopCount");
  assert.equal(service.getName(regId(0, 999)), null, "an id outside the request must never be written");
  assert.equal(result.droppedUnknownNames, 1);
});

test("runNamePass (function batch): the equiv backstop reverts and re-applies the WHOLE function's write set as one proof", async () => {
  const service = svc();
  const before = service.render().code;
  const backend = new FakeBackend({
    replies: {
      "suggest-name": () =>
        fnReply([
          { fn: 0, reg: 9, name: "loopCount" },
          { fn: 0, reg: 3, name: "accumulator" },
        ]),
    },
  });
  const result = await runNamePass([fnTarget([9, 3])], { backend, service });

  assert.equal(result.equiv.scope, "name");
  assert.equal(result.equiv.verdict, "PASS");
  assert.equal(result.equiv.coverage.records, 2, "the backstop's own coverage counts both registers it reverted+restored");
  assert.notEqual(service.render().code, before, "both names are re-applied after the backstop proves the revert was clean");
});

test("runNamePass: a plain register target list is still one call per register (per-register mode unchanged)", async () => {
  const service = svc();
  const calls: WorkerJobRequest[] = [];
  const backend = new FakeBackend({
    replies: {
      "suggest-name": (req) => {
        calls.push(req);
        const reg = Number(req.context["reg"]);
        return fnReply([{ fn: 0, reg, name: reg === 9 ? "loopCount" : "accumulator" }]);
      },
    },
  });
  const targets: NamePassTarget[] = [9, 3].map((reg) => {
    const id = regId(0, reg);
    return { bindingId: id, kind: "suggest-name", context: { target: shortForm(id), fn: 0, reg, source: "s" } };
  });
  const result = await runNamePass(targets, { backend, service });
  assert.equal(calls.length, 2, "per-register mode must still make one call per target");
  assert.equal(namedCount(result.outcomes), 2);
  assert.equal(targets.every((t) => !isFunctionTarget(t)), true);
});

test("cacheKey: two identical function-batch contexts hash the same (a re-run over an unchanged function is a cache hit)", () => {
  const skill = loadSkill("hbc-name", join(repoRoot(), "skills"));
  const model = "claude-haiku-4-5-20251001";
  const buildKey = (targets: readonly string[]): string => {
    const context = { fn: 0, targets, source: "function f0(){ return 1; }" };
    return cacheKey({
      kind: "suggest-name",
      skillId: "hbc-name",
      skillVersion: skill.version,
      model,
      body: bodyFromContext(context),
      context: canonicaliseContext(context),
    });
  };
  assert.equal(buildKey(["{0,9}", "{0,3}"]), buildKey(["{0,9}", "{0,3}"]), "identical function-batch requests must share a cache key");
  assert.notEqual(buildKey(["{0,9}", "{0,3}"]), buildKey(["{0,9}"]), "a different requested-register set is a different function, cache-wise");
});

// -- BUGS 2026-09-11 "render() is O(whole-bundle) per call" -----------------
function liveCallsTo(source: string, callee: string): number {
  const withoutComments = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");
  return (withoutComments.match(new RegExp(`${callee.replace(/[.()]/g, "\\$&")}\\(`, "g")) ?? []).length;
}

test("BUGS 2026-09-11 (render O(whole-bundle)): record.ts's prompt source is decompileFunction, never service.render({fn})", () => {
  const src = readFileSync(join(repoRoot(), "tools", "readability", "record.ts"), "utf8");
  assert.equal(liveCallsTo(src, "service.render"), 0, "record.ts must not call NameService.render({fn}) for a naming prompt's source");
  assert.ok(liveCallsTo(src, "decompileFunction") >= 1, "record.ts must render a target's source through the scoped decompileFunction");
});

test("BUGS 2026-09-11 (render O(whole-bundle)): name llm-fill's target builders use decompileFunction, never service.render({fn})", () => {
  const src = readFileSync(join(repoRoot(), "src", "cli.ts"), "utf8");
  const start = src.indexOf("function llmFillTargetsForFn(");
  const end = src.indexOf("function llmFillBackend(");
  assert.ok(start >= 0 && end > start, "src/cli.ts's llm-fill target builders must still exist under these names");
  const region = src.slice(start, end);
  assert.equal(liveCallsTo(region, "service.render"), 0, "name llm-fill's target builders must not call NameService.render({fn})");
  assert.ok(liveCallsTo(region, "renderFn"), "name llm-fill's target builders must render through the scoped renderFn (decompileFunction) callback");
});

test("runNamePass equiv backstop: NameService.render() (whole module) is called O(1) times per run, never once per function/target", async () => {
  startOnlySrcCli(); // overlaps the child with this test's in-process work
  const hbc = RN_HBC;
  const scope = await rnScope();
  const store = new OverlayStore({ bundle: hbc });
  const service = new NameService(scope.analysis, store, { strictEnv: false });
  const frames = rawFrameBodies(scope.analysis, { strictEnv: false });

  const srcFns = [...scope.srcFns];
  assert.ok(srcFns.length >= 3, "rn-template-0.72's --only src scope must span several distinct functions for this test to be meaningful");

  const targets: NamePassFunctionTarget[] = [];
  for (const fn of srcFns) {
    const nameable = listNameable(frames, fn, store).filter((r) => r.named === null);
    if (nameable.length === 0) continue;
    const ids = nameable.map((r) => regId(fn, r.reg));
    targets.push({ kind: "suggest-name", fn, regs: ids, context: { fn, targets: ids.map((id) => shortForm(id)), source: `function f${String(fn)}(){}` } });
  }
  assert.ok(targets.length >= 3, "must have built function targets across several distinct functions");

  let wholeModuleRenderCalls = 0;
  let scopedRenderCalls = 0;
  const originalRender = service.render.bind(service);
  // Instance-level override: `runNamePass` calls `opts.service.render(...)`
  // on this exact instance, so the override is seen from inside it too.
  service.render = (opts: RenderOptions = {}): RenderResult => {
    if (opts.fn === undefined) wholeModuleRenderCalls++;
    else scopedRenderCalls++;
    return originalRender(opts);
  };

  const backend = new FakeBackend({
    replies: {
      "suggest-name": (req) => {
        const ctx = req.context as { fn: number; targets: readonly string[] };
        return JSON.stringify({
          names: ctx.targets.map((t) => {
            const m = /\{(\d+),(\d+)\}/.exec(t)!;
            return { bindingId: { fn: Number(m[1]), reg: Number(m[2]) }, name: `named_${m[1]}_${m[2]}`, confidence: "high", evidence: "e" };
          }),
          abstained: false,
        });
      },
    },
  });

  const result = await runNamePass(targets, { backend, service });
  assert.equal(result.equiv.verdict, "PASS");
  assert.ok(namedCount(result.outcomes) > 0, "at least one register across the several functions must actually get written");
  assert.equal(wholeModuleRenderCalls, 2, "the backstop must call the whole-module render exactly twice (before, restored) regardless of target/function count");
  assert.equal(scopedRenderCalls, 0, "runNamePass's own backstop never needs a scoped render -- only the whole-module one");
});

test("CLI: name llm-fill --only src actually restricts targets to computeSrcScope's srcFns (was documented, never implemented)", async () => {
  const scope = await rnScope();
  assert.ok(scope.srcFns.size > 0 && scope.srcFns.size < scope.analysis.module.functions.length, "the fixture must have a proper src subset for this test to mean anything");

  const r = await startOnlySrcCli();
  try {
    assert.equal(r.status, 0, r.stderr);
    const summary = JSON.parse(r.stdout) as { targets: number };
    assert.ok(summary.targets > 0, "the src scope must yield at least one target on this fixture");
    assert.ok(summary.targets <= scope.srcFns.size, "--only src must never build more function-batch targets than there are src-bucket functions");
  } finally {
    if (onlySrcDir !== undefined) rmSync(onlySrcDir, { recursive: true, force: true });
  }
});
