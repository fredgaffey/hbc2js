// Spec 29 section 12, "Scoped rewrite checks": `checkOneStatementRewrite`
// (the linear form of a one-statement rung check: "the result parses" and
// "no new free name") returns the same verdict and the same reason as the
// original whole-list print+compile and whole-list `freeNames`. The old path
// stays behind HBC2JS_SCOPED_CHECK=whole; `both` runs the two and throws on
// any disagreement, which is how the differential cases below are checked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Expr, Stmt } from "../../../src/emit/ast.ts";
import { checkOneStatementRewrite, scopedCheckStats } from "../../../src/passes/scoped-check.ts";
import { decompile } from "../../../src/decompile.ts";
import { repoRoot } from "../../support/paths.ts";

const id = (name: string): Expr => ({ k: "ident", name });
const call = (name: string, ...args: Expr[]): Stmt => ({ k: "expr", expr: { k: "call", callee: id(name), args } } as Stmt);
const fn = (name: string, body: readonly Stmt[], generator = false): Stmt => ({ k: "func", name, params: [], body, ...(generator ? { generator: true as const } : {}) });
const lit = (text: string): Expr => ({ k: "lit", text });

/** Check `before` -> `before` with statement `i` replaced by `got`, in `both`
 *  mode, twice in a row (the second exercises the moved list index). */
function both(before: readonly Stmt[], i: number, got: Stmt): { ok: boolean; reason?: string } {
  const saved = process.env["HBC2JS_SCOPED_CHECK"];
  process.env["HBC2JS_SCOPED_CHECK"] = "both";
  try {
    const after = before.map((s, j) => (j === i ? got : s));
    const v = checkOneStatementRewrite(before, after, i);
    // And back again, from the index `after` now owns.
    checkOneStatementRewrite(after, before, i);
    return v;
  } finally {
    if (saved === undefined) delete process.env["HBC2JS_SCOPED_CHECK"];
    else process.env["HBC2JS_SCOPED_CHECK"] = saved;
  }
}

void test("scoped check: same verdict as the whole-list check on the cross-statement cases", () => {
  const stub = fn("g", [call("f", id("a"))]);
  const gen = fn("g", [{ k: "expr", expr: { k: "yield", arg: id("a"), delegate: false } } as Stmt], true);
  const genNew = fn("g", [call("h", id("zz"))], true);
  const cases: { name: string; list: Stmt[]; ok: boolean; reason?: RegExp }[] = [
    { name: "plain", list: [call("x"), stub, { k: "init", kind: "let", name: "a", value: lit("1") }], ok: true },
    // A top-level `let g` collides with the function declaration `g` in the
    // whole body (lexical vs var-scoped): both checks reject.
    { name: "let vs function", list: [{ k: "decl", kind: "let", names: ["g"] }, stub], ok: false, reason: /not syntactically valid/ },
    // A `var` deep in a block of another statement collides with a top-level `let`.
    { name: "nested var vs let", list: [{ k: "init", kind: "let", name: "q", value: lit("1") }, { k: "if", test: id("c"), then: [{ k: "decl", kind: "var", names: ["q"] }], else: [] }, stub], ok: false },
    // Two top-level `let`s of one name elsewhere in the list.
    { name: "let let", list: [{ k: "decl", kind: "let", names: ["d"] }, stub, { k: "decl", kind: "const", names: ["d"] }], ok: false },
    // Strict prologue: `with` is a syntax error in another statement.
    { name: "strict with", list: [{ k: "directive", text: "use strict" }, { k: "raw", text: "with (o) {}" }, stub], ok: false },
    // Strict prologue reaches every statement's scoped parse: a legacy octal
    // literal is a syntax error under it and fine without it.
    { name: "strict octal", list: [{ k: "directive", text: "use strict" }, call("x", lit("010")), stub], ok: false },
    { name: "sloppy octal", list: [call("x", lit("010")), stub], ok: true },
    { name: "sloppy with", list: [{ k: "raw", text: "with (o) {}" }, stub], ok: true },
    // A statement that does not parse alone.
    { name: "bad sibling", list: [call("x"), { k: "break", label: "nowhere" }, stub], ok: false },
    // A nested block-level `let` does not collide.
    { name: "block let", list: [{ k: "if", test: id("c"), then: [{ k: "decl", kind: "let", names: ["g"] }], else: [] }, stub], ok: true },
  ];
  for (const c of cases) {
    const i = c.list.indexOf(stub);
    const v = both(c.list, i, gen);
    assert.equal(v.ok, c.ok, c.name);
    if (c.reason !== undefined) assert.match(v.reason ?? "", c.reason, c.name);
  }
  // A new free name: the same first name in the whole-list order.
  const v = both([call("x"), stub, call("y")], 1, genNew);
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /free name `h`/);
  // A name bound only by the replaced statement and used elsewhere becomes free.
  const binds = fn("g", [{ k: "init", kind: "var", name: "w", value: lit("1") }]);
  const v2 = both([call("w"), binds], 1, fn("g", [], true));
  assert.equal(v2.ok, false);
  assert.match(v2.reason ?? "", /free name `w`/);
});

void test("scoped check: every generator rewrite on rn-template-0.72 and the generator constructs agrees with the whole-list check", () => {
  const saved = process.env["HBC2JS_SCOPED_CHECK"];
  process.env["HBC2JS_SCOPED_CHECK"] = "both";
  const before = scopedCheckStats.compared;
  try {
    decompile(readFileSync(join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc")));
    const constructs = join(repoRoot(), "tests", "fixtures", "constructs");
    for (const f of readdirSync(constructs).filter((d) => /gen|async/.test(d))) {
      for (const v of readdirSync(join(constructs, f)).filter((x) => x.endsWith(".hbc"))) decompile(readFileSync(join(constructs, f, v)), { resolveV98Ambiguity: true });
    }
  } finally {
    if (saved === undefined) delete process.env["HBC2JS_SCOPED_CHECK"];
    else process.env["HBC2JS_SCOPED_CHECK"] = saved;
  }
  assert.ok(scopedCheckStats.compared - before > 150, "no generator rewrite was checked");
  if (process.env["HBC2JS_SCOPED_CHECK_STATS"] === "1") console.log(JSON.stringify(scopedCheckStats));
});
