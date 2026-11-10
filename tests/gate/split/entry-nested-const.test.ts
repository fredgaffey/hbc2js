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

test("export-boot L4: a register given two different ids in nested blocks stays unresolved", () => {
  const body = [labelled([assign("r2", lit("0"))]), labelled([assign("r2", lit("7"))]), ...rCall("r2")];
  assert.deepEqual(resolveStartupModuleIds(body), []);
});
