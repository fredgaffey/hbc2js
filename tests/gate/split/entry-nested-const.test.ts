// export-boot L4 (react-navigation B1): hermesc -O materialises the entry id
// `0` into a register once, inside a labelled block early in the global
// function, and the final `__r(r2)` reads it at top level. The startup-id scan
// only tracked top-level assignments, so it dropped `__r(0)` — the export ran
// InitializeCore and module 986 but never the app entry.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Stmt, Expr } from "../../../src/emit/ast.ts";
import { resolveStartupModuleIds } from "../../../src/split/entry.ts";

const id = (name: string): Expr => ({ k: "ident", name }) as Expr;
const lit = (text: string): Expr => ({ k: "lit", text }) as Expr;
const o = { fn: 0, start: 0, end: 1 };
const assign = (name: string, value: Expr): Stmt => ({ k: "expr", expr: { k: "assign", target: id(name), value }, origin: o }) as unknown as Stmt;
const rCall = (arg: string): Stmt[] => [
  assign("r10", { k: "member", obj: id("r9"), prop: lit("__r"), computed: false } as Expr),
  assign("r10", { k: "call", callee: { k: "member", obj: id("Reflect"), prop: lit("apply"), computed: false }, args: [id("r10"), id("r6"), { k: "array", elements: [id(arg)] }] } as unknown as Expr),
];
const labelled = (body: Stmt[]): Stmt => ({ k: "labeled", label: "L1", body, origin: o }) as unknown as Stmt;

test("export-boot L4: a startup id held in a register set once inside a nested block is still found", () => {
  const body = [labelled([assign("r2", lit("0"))]), assign("r3", lit("131")), ...rCall("r3"), ...rCall("r2")];
  assert.deepEqual(resolveStartupModuleIds(body), [131, 0]);
});

test("export-boot L4: a register given two different ids, one under a conditional, stays unresolved", () => {
  const cond = (body: Stmt[]): Stmt => ({ k: "if", test: id("r5"), then: body, else: null, origin: o }) as unknown as Stmt;
  const body = [labelled([assign("r2", lit("0"))]), cond([assign("r2", lit("7"))]), ...rCall("r2")];
  assert.deepEqual(resolveStartupModuleIds(body), []);
});

test("export-boot apps: a reused register's last unconditional write is the entry id (Expensify r3: 65535, then 0)", () => {
  // Expensify fn#0 writes r3 = 65535 (a __d id) at offset 588 and r3 = 0 at
  // 1393/1731; the final __r(r3) was dropped, so the export never entered
  // module 0 (B1 DIVERGENT at entry 155: original "enter 0", export <end>).
  const body = [assign("r3", lit("65535")), labelled([assign("r3", lit("0"))]), labelled([assign("r3", lit("0"))]), assign("r1", lit("100")), ...rCall("r1"), ...rCall("r3")];
  assert.deepEqual(resolveStartupModuleIds(body), [100, 0]);
});

test("export-boot apps: the entry id written on both arms of a branch is read from the bytecode CFG (Expensify r3: 65535, then 0 under an if)", async () => {
  // Expensify fn#0 (re-export, 2026-11-10): r3 = 65535 at offset 588, then
  // r3 = 0 at 1393 (inside a branch) and 1731 (a join the structurer placed
  // under an `if`). The AST scan saw a conditional write differing from an
  // earlier one and dropped __r(r3); every path reaches the call with 0.
  const { constRegisterBefore } = await import("../../../src/split/entry.ts");
  const reg = (value: number) => ({ type: "Reg8", role: "reg", value });
  const insn = (offset: number, name: string, operands: unknown[]) => ({ offset, name, operands });
  const block = (bid: number, start: number, end: number, instructions: unknown[], succs: number[], preds: number[]) =>
    ({ id: bid, start, end, instructions, terminator: {}, succs: succs.map((to) => ({ from: bid, to, kind: "jump" })), preds, isHandlerEntry: false });
  const cfg = {
    functionIndex: 0, entry: 0, exits: [3], byOffset: new Map(), exceptionSuccs: new Map(), regions: [], switchTables: [],
    blocks: [
      block(0, 0, 10, [insn(0, "LoadConstInt", [reg(3), { role: "imm", value: 65535 }]), insn(6, "JmpTrue", [{ role: "imm", value: 10 }, reg(5)])], [1, 2], []),
      block(1, 10, 20, [insn(10, "LoadConstZero", [reg(3)]), insn(12, "Jmp", [{ role: "imm", value: 8 }])], [3], [0]),
      block(2, 20, 30, [insn(20, "LoadConstZero", [reg(3)])], [3], [0]),
      block(3, 30, 40, [insn(30, "TryGetById", [reg(10), reg(9), { role: "imm", value: 0 }, { role: "string", value: 1 }]), insn(36, "Call2", [reg(10), reg(10), reg(6), reg(3)])], [], [1, 2]),
    ],
  } as never;
  assert.equal(constRegisterBefore(cfg, 41, 3), 0);
  // One arm leaves the earlier id in place: unresolved.
  const mixed = { ...(cfg as object), blocks: (cfg as { blocks: { instructions: unknown[] }[] }).blocks.map((b, i) => (i === 2 ? { ...b, instructions: [] } : b)) } as never;
  assert.equal(constRegisterBefore(mixed, 41, 3), undefined);
  const cond = (body: Stmt[]): Stmt => ({ k: "if", test: id("r5"), then: body, else: null, origin: o }) as unknown as Stmt;
  const call = { ...(rCall("r3")[1] as object), origin: { fn: 0, start: 30, end: 41 } } as unknown as Stmt;
  const body = [assign("r3", lit("65535")), cond([assign("r3", lit("0"))]), assign("r3", lit("0")), rCall("r3")[0]!, call];
  const shaped = [assign("r3", lit("65535")), cond([assign("r3", lit("0"))]), cond([assign("r3", lit("0"))]), rCall("r3")[0]!, call];
  assert.deepEqual(resolveStartupModuleIds(body, cfg), [0]);
  assert.deepEqual(resolveStartupModuleIds(shaped, cfg), [0]);
});
