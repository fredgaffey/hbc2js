// fcall-diamond (docs/specs/passes/04-call-shape.md section 8, rule R3g):
// roundtrip review `diff:TryGetById(reg)` bucket, 2026-11-09 — v98's
// `JmpBuiltinIs functionPrototypeCall` diamond for `f.call(t, ...)` printed as
// `if (c === __hbc_b_functionPrototypeCall) {...}` instead of `f.call(t, ...)`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { decompile } from "../../../src/decompile.ts";
import type { Instruction } from "../../../src/disasm/decode.ts";
import { runTier, hbc2jsDecompiler } from "../../../src/harness/tiers.ts";
import { VERDICT } from "../../../src/harness/ladder.ts";
import { callsCorrespond, evalArm, mismatchedRegisters } from "../../../src/passes/fcall-diamond/diamond.ts";

const FIXTURE = "170-function-call-diamond";
const code = (v: number, skip: readonly string[] = []): string =>
  decompile(new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", FIXTURE, `v${v}.hbc`))), { moduleName: FIXTURE, resolveV98Ambiguity: true, passes: { skip } }).code;

test("roundtrip-fcall: the v98/v99 f.call diamond prints as f.call(...), no builtin shim left", () => {
  for (const v of [98, 99]) {
    const out = code(v);
    assert.ok(!out.includes("__hbc_b_functionPrototypeCall"), `v${v} still has the shim:\n${out}`);
    assert.ok((out.match(/\.call\(/g) ?? []).length >= 5, `v${v}: expected >=5 .call( sites:\n${out}`);
  }
});

test("roundtrip-fcall: without the rung the diamond is still there (the rung is what removes it)", () => {
  assert.ok(code(98, ["fcall-diamond"]).includes("__hbc_b_functionPrototypeCall"));
});

test("roundtrip-fcall: fixture 170 (incl. shadowed and overridden .call) is T2 PASS at every version", async () => {
  const report = await runTier({ tier: "gate", decompiler: hbc2jsDecompiler, only: [FIXTURE], versions: [84, 94, 96, 98, 99] });
  const bad = report.results.filter((r) => r.verdict !== VERDICT.PASS).map((r) => `${r.fixture.name}: ${r.verdict}`);
  assert.deepEqual(bad, []);
  assert.ok(report.results.length >= 5, `only ${report.results.map((r) => r.fixture.name).join(",")} ran`);
});

// --- arm proof, hand-built arms ------------------------------------------------
let off = 0;
const ins = (name: string, ...vals: number[]): Instruction =>
  ({ name, offset: off++, operands: vals.map((value, i) => ({ type: "Reg8", role: i === 0 || !name.startsWith("LoadConst") ? "reg" : "imm", value })) }) as unknown as Instruction;
const BASE = 10; // argSlotBase

function proof(fast: Instruction[], generic: Instruction[], tested: number): string | null {
  const fa = evalArm(fast, BASE);
  const ga = evalArm(generic, BASE);
  if (typeof fa === "string") return fa;
  if (typeof ga === "string") return ga;
  return callsCorrespond(fa.call, ga.call, tested);
}

test("roundtrip-fcall: the arm proof accepts the measured shapes", () => {
  // f.call(t, a, b): fast Call3 r0, F=r4, T=r3, r2, r1 ; generic Call4 r0, C=r0, r4, r3, r2, r1
  assert.equal(proof([ins("Call3", 0, 4, 3, 2, 1)], [ins("Call4", 0, 0, 4, 3, 2, 1), ins("Jmp", 0)], 0), null);
  // a constant argument in a different register per arm
  assert.equal(proof([ins("LoadConstString", 18, 7), ins("Call2", 17, 21, 19, 18)], [ins("LoadConstString", 17, 7), ins("Call3", 17, 18, 21, 19, 17), ins("Jmp", 0)], 18), null);
  // f.call(): the fast arm materialises the missing `this` as undefined
  assert.equal(proof([ins("LoadConstUndefined", 0), ins("Call1", 1, 2, 0)], [ins("Call1", 1, 1, 2), ins("Jmp", 0)], 1), null);
  // long-form generic Call: arg[i] at BASE - i
  assert.equal(proof([ins("Call4", 0, 5, 4, 3, 2, 1)], [ins("Mov", 10, 5), ins("Mov", 9, 4), ins("Mov", 8, 3), ins("Mov", 7, 2), ins("Mov", 6, 1), ins("Call", 0, 0, 5), ins("Jmp", 0)], 0), null);
});

test("roundtrip-fcall: negative twins — arms that are not the same call are refused", () => {
  // generic callee is not the tested register
  assert.equal(proof([ins("Call2", 0, 4, 3, 2)], [ins("Call3", 0, 5, 4, 3, 2)], 0), "generic-callee-not-tested");
  // generic `this` is not the fast callee
  assert.equal(proof([ins("Call2", 0, 4, 3, 2)], [ins("Call3", 0, 0, 6, 3, 2)], 0), "this-not-fast-callee");
  // different argument
  assert.equal(proof([ins("Call2", 0, 4, 3, 2)], [ins("Call3", 0, 0, 4, 3, 1)], 0), "arg-1");
  // different constant
  assert.equal(proof([ins("LoadConstUInt8", 1, 1), ins("Call2", 0, 4, 3, 1)], [ins("LoadConstUInt8", 1, 2), ins("Call3", 0, 0, 4, 3, 1)], 0), "arg-1");
  // arity mismatch
  assert.equal(proof([ins("Call3", 0, 4, 3, 2, 1)], [ins("Call3", 0, 0, 4, 3, 2)], 0), "arg-count");
  // an unmodelled (effectful) instruction in an arm
  assert.equal(proof([ins("GetByIdShort", 2, 4, 0, 0), ins("Call2", 0, 4, 3, 2)], [ins("Call3", 0, 0, 4, 3, 2)], 0), "arm-insn:GetByIdShort");
  // the fast arm's last instruction is not a call
  assert.equal(proof([ins("Ret", 0)], [ins("Call3", 0, 0, 4, 3, 2)], 0), "arm-last:Ret");
});

test("roundtrip-fcall: registers the arms leave different are reported for the liveness proof", () => {
  const fa = evalArm([ins("LoadConstString", 18, 7), ins("Call2", 17, 21, 19, 18)], BASE);
  const ga = evalArm([ins("LoadConstString", 17, 7), ins("Call3", 17, 18, 21, 19, 17)], BASE);
  assert.ok(typeof fa !== "string" && typeof ga !== "string");
  assert.deepEqual(mismatchedRegisters(fa.writes, ga.writes), [18]);
  assert.deepEqual(mismatchedRegisters(fa.preCall, ga.preCall), [17, 18]);
});
