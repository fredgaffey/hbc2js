// Corpus a03 (hbc98, react-navigation `getPathFromState`): an inlined callee
// is reconstructed as an `iife` statement; a loop inside it creates a
// per-iteration environment whose `let` landed in a labeled block, and the
// reads in sibling blocks were unbound (E_UNBOUND_IDENT, function isolated).
// `settleLoopLocalDecls` did not descend into `iife` bodies, so it never saw
// the declaration. It now treats an IIFE body as one more block.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Stmt } from "../../../src/emit/ast.ts";
import { id } from "../../../src/emit/ast.ts";
import { printProgram } from "../../../src/emit/print.ts";
import { settleLoopLocalDecls } from "../../../src/emit/loop-env-scope.ts";

const set = (name: string, value: string): Stmt => ({ k: "expr", expr: { k: "assign", target: id(name), value: id(value) } }) as Stmt;

test("loop-local env decl inside an inlined-callee iife is settled to the loop body", () => {
  const loopBody: Stmt[] = [
    { k: "labeled", label: "L8", body: [{ k: "decl", kind: "let", names: ["_e1531_0", "_e1531_1"] }, set("_e1531_0", "r24"), { k: "break", label: "L8" }] } as unknown as Stmt,
    { k: "labeled", label: "L23", body: [set("_e1531_1", "r25"), { k: "break", label: "L23" }] } as unknown as Stmt,
    set("r1", "_e1531_0"),
  ];
  const body: Stmt[] = [{ k: "iife", body: [{ k: "do-while", body: loopBody, test: id("r12") } as unknown as Stmt] } as Stmt];
  const r = settleLoopLocalDecls(body, [["_e1531_0", "_e1531_1"]]);
  assert.deepEqual(r.widened, []);
  const text = printProgram(r.body);
  // The declaration now heads the loop body, before both labeled blocks.
  const declAt = text.indexOf("let _e1531_0, _e1531_1;");
  assert.ok(declAt >= 0, text);
  assert.ok(declAt < text.indexOf("L8:"), text);
  assert.ok(text.indexOf("do {") < declAt, text);
});
