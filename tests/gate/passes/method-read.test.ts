// method-read (spec 05 section 7.4; docs/BUGS.md 2026-11-09 "method read moved
// past an intervening getter"): the emitter leaves a method read unfused when
// observable work sits between it and the call; this rung re-fuses it with the
// work inside the first argument (read -> work -> arguments, as hermesc ran
// them) and folds trailing register definitions back into their slots.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Expr, Stmt } from "../../../src/passes/ast.ts";
import type { PassContext } from "../../../src/passes/types.ts";
import { matchSite } from "../../../src/passes/method-read/match.ts";
import { check } from "../../../src/passes/method-read/check.ts";
import { rewrite } from "../../../src/passes/method-read/rewrite.ts";
import { expr as printExpr } from "../../../src/emit/print.ts";

const id = (name: string): Expr => ({ k: "ident", name });
const lit = (text: string): Expr => ({ k: "lit", text });
const mem = (obj: Expr, p: string): Expr => ({ k: "member", obj, prop: lit(p), computed: false });
const set = (name: string, value: Expr): Stmt => ({ k: "expr", expr: { k: "assign", target: id(name), value } });
const apply = (f: string, o: string, args: Expr[], methodRead = true): Expr => ({ k: "call", callee: mem(id("Reflect"), "apply"), args: [id(f), id(o), { k: "array", elements: args }], ...(methodRead ? { methodRead: true as const } : {}) });

function run(list: Stmt[]): string | null {
  const site = matchSite(list, list);
  if (site === null) return null;
  const after = rewrite({ root: list, nodes: [list], data: site, at: { functionIndex: 0, offset: 0 } });
  assert.deepEqual(check(list, after, { fnBody: list } as unknown as PassContext), { ok: true });
  return after.map((s) => (s.k === "expr" ? printExpr(s.expr, 0) : s.k)).join("; ");
}

test("method-read: the read is re-fused and a getter argument folds into its slot after it", () => {
  // r3 = api.m; r1 = src.v; r2 = Reflect.apply(r3, r0, [r1])
  const out = run([set("r3", mem(id("r0"), "m")), set("r1", mem(id("src"), "v")), set("r2", apply("r3", "r0", [id("r1")]))]);
  assert.equal(out, 'r2 = r0.m(src.v)');
});

test("method-read: an untagged Reflect.apply is not this rung's", () => {
  assert.equal(run([set("r3", mem(id("r0"), "m")), set("r1", mem(id("src"), "v")), set("r2", apply("r3", "r0", [id("r1")], false))]), null);
});

test("method-read: a definition never moves past an earlier slot that evaluates something", () => {
  // args [r2, r1] defined in the order r1, r2: r2 folds into slot 0, r1 may not
  // jump over `c.d` into slot 1, so it stays in the sequence, in order.
  const out = run([set("r3", mem(id("r0"), "m")), set("r1", mem(id("a"), "b")), set("r2", mem(id("c"), "d")), set("r4", apply("r3", "r0", [id("r2"), id("r1")]))]);
  assert.equal(out, "r4 = r0.m((r1 = a.b, c.d), r1)");
});

test("method-read: a register still live after the call stays an assignment in the first slot", () => {
  const list = [set("r3", mem(id("r0"), "m")), set("r1", mem(id("a"), "b")), set("r4", apply("r3", "r0", [id("r1")])), set("r5", id("r1"))];
  assert.equal(run(list)?.split("; ")[0], "r4 = r0.m(r1 = a.b)");
});

test("method-read: a write to the receiver in between refuses the fusion", () => {
  assert.equal(run([set("r3", mem(id("r0"), "m")), set("r0", mem(id("a"), "b")), set("r2", apply("r3", "r0", [id("r0")]))]), null);
});
