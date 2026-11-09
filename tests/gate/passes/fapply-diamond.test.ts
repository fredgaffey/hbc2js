// fcall-diamond, `apply` form
// (docs/specs/passes/04-call-shape.md section 10, rule R3g): roundtrip review
// "passes-roundtrip-apply", 2026-11-09 — v98's `JmpBuiltinIs
// functionPrototypeApply` diamond for `f.apply(t, arguments)` printed as
// `if (apply === __hbc_b_functionPrototypeApply) {...}`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { decompile } from "../../../src/decompile.ts";
import type { Instruction } from "../../../src/disasm/decode.ts";
import { runTier, hbc2jsDecompiler } from "../../../src/harness/tiers.ts";
import { VERDICT } from "../../../src/harness/ladder.ts";
import { ARGUMENTS, UNDEF, applyCallsCorrespond, evalArm } from "../../../src/passes/fcall-diamond/diamond.ts";

const APPLY = "220-function-apply-diamond";
const CALL = "170-function-call-diamond";
const code = (fixture: string, v: number, skip: readonly string[] = []): string =>
  decompile(new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", fixture, `v${v}.hbc`))), { moduleName: fixture, resolveV98Ambiguity: true, passes: { skip } }).code;

test("roundtrip-apply: the v98/v99 f.apply(t, arguments) diamond prints as f.apply(t, arguments), no builtin shim left", () => {
  for (const v of [98, 99]) {
    const out = code(APPLY, v);
    assert.ok(!out.includes("__hbc_b_functionPrototypeApply") && !out.includes("__hbc_b_applyArguments("), `v${v} still has the shim:\n${out}`);
    // forward, forwardThis, forwardNoParams are bare `arguments`; forwardLoose keeps the loose copy helper (mapped arguments, spec 23 R-A3)
    assert.ok((out.match(/\.apply\(\w+, arguments\)/g) ?? []).length >= 3, `v${v}: expected >=3 .apply(t, arguments) sites:\n${out}`);
    assert.ok(/\.apply\(\w+, __hbc_arguments\(arguments\)\)/.test(out), `v${v}: forwardLoose:\n${out}`);
  }
});

test("roundtrip-apply: without the rung the apply diamond is still there", () => {
  assert.ok(code(APPLY, 98, ["fcall-diamond"]).includes("__hbc_b_functionPrototypeApply"));
});

test("roundtrip-apply: fixture 220 (incl. shadowed .apply and overridden Function.prototype.apply) is T2 PASS at every version", async () => {
  const report = await runTier({ tier: "gate", decompiler: hbc2jsDecompiler, only: [APPLY, CALL], versions: [84, 94, 96, 98, 99] });
  const bad = report.results.filter((r) => r.verdict !== VERDICT.PASS).map((r) => `${r.fixture.name}: ${r.verdict}`);
  assert.deepEqual(bad, []);
  assert.ok(report.results.filter((r) => r.fixture.name.startsWith(APPLY)).length >= 5, `only ${report.results.map((r) => r.fixture.name).join(",")} ran`);
});

// --- arm proof, hand-built arms ------------------------------------------------
let off = 0;
const ins = (name: string, ...vals: number[]): Instruction =>
  ({ name, offset: off++, operands: vals.map((value, i) => ({ type: "Reg8", role: i === 0 || !(name.startsWith("LoadConst") || name.startsWith("CallBuiltin")) || (name.startsWith("CallBuiltin") && i === 0) ? "reg" : "imm", value })) }) as unknown as Instruction;
const BASE = 8; // argSlotBase
const AA = 50; // applyArguments builtin index

function proof(fast: Instruction[], generic: Instruction[], tested: number): string | null {
  const fa = evalArm(fast, BASE, { reify: true });
  const ga = evalArm(generic, BASE, { reify: true });
  if (typeof fa === "string") return fa;
  if (typeof ga === "string") return ga;
  return applyCallsCorrespond(fa.call, ga.call, tested, AA);
}

test("roundtrip-apply: the arm proof accepts the measured shape (applyStrict, v99)", () => {
  // fast: Mov r7, r3 (F); Mov r6, r4 (T); CallBuiltin r2, applyArguments, 3
  const fast = [ins("Mov", 7, 3), ins("Mov", 6, 4), ins("CallBuiltin", 2, AA, 3)];
  // generic: ReifyArgumentsStrict r2; Call3 r2, r5 (C), r3 (F), r4 (T), r2 (A); Jmp
  const generic = [ins("ReifyArgumentsStrict", 2), ins("Call3", 2, 5, 3, 4, 2), ins("Jmp", 0)];
  assert.equal(proof(fast, generic, 5), null);
  const fa = evalArm(fast, BASE, { reify: true });
  assert.ok(typeof fa !== "string" && fa.call.args[0] === UNDEF, "CallBuiltin's implicit this is undefined");
  const ga = evalArm(generic, BASE, { reify: true });
  assert.ok(typeof ga !== "string" && ga.call.args[2] === ARGUMENTS);
});

test("roundtrip-apply: negative twins — arms that are not the same apply are refused", () => {
  const generic = [ins("ReifyArgumentsStrict", 2), ins("Call3", 2, 5, 3, 4, 2), ins("Jmp", 0)];
  // fast arm calls some other builtin
  assert.equal(proof([ins("Mov", 7, 3), ins("Mov", 6, 4), ins("CallBuiltin", 2, AA + 1, 3)], generic, 5), "fast-not-applyArguments");
  // fast arm forwards a different `this`
  assert.equal(proof([ins("Mov", 7, 3), ins("Mov", 6, 1), ins("CallBuiltin", 2, AA, 3)], generic, 5), "arg-0");
  // fast arm applies a different function
  assert.equal(proof([ins("Mov", 7, 1), ins("Mov", 6, 4), ins("CallBuiltin", 2, AA, 3)], generic, 5), "this-not-fast-callee");
  // generic arm passes something other than the reified arguments object (`f.apply(t, args)`)
  assert.equal(proof([ins("Mov", 7, 3), ins("Mov", 6, 4), ins("CallBuiltin", 2, AA, 3)], [ins("Call3", 2, 5, 3, 4, 1), ins("Jmp", 0)], 5), "apply-args-not-arguments");
  // generic callee is not the tested register
  assert.equal(proof([ins("Mov", 7, 3), ins("Mov", 6, 4), ins("CallBuiltin", 2, AA, 3)], generic, 6), "generic-callee-not-tested");
  // without the apply option a reify is an unmodelled instruction (the `call` diamond never reifies)
  assert.equal(evalArm(generic, BASE), "arm-insn:ReifyArgumentsStrict");
});
