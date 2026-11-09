// value-join matcher — docs/specs/passes/32-value-join.md §2.
//
// Recognises the labelled block the structurer leaves for an `||`/`&&`/`?:`
// whose value is assigned to one register:
//
//   L: { pre…; if (T) { thenLead…; [rX = A;] break L; } elseLead…; rX = B; break L; }
//
// where `L` has exactly those two uses and nothing in `pre`/the arms declares
// a binding. The site becomes `pre…; rX = <join>;` with the label gone:
// `<join>` is `T ? (thenLead…, A) : (elseLead…, B)`, `A` defaulting to `rX`
// itself when the then-arm is a bare `break` (rX already holds the value the
// short-circuit keeps). Exact: the same expressions are evaluated in the
// same order on both paths, and `rX` receives the same final value; only
// the label's two jumps become the conditional expression's own.
import type { Expr, Stmt } from "../ast.ts";
import { isRegisterName, walk } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";

export interface ValueJoinSite {
  readonly index: number; // the labelled block's index in the list
  readonly pre: readonly Stmt[];
  readonly target: string;
  readonly value: Expr;
}

export type ValueJoinMatch = Match<readonly Stmt[], ValueJoinSite>;

/** Every `break label` / `continue label` reachable in `stmts`, nested
 *  functions excluded (a different frame cannot jump to this label). */
export function labelUses(stmts: readonly Stmt[], label: string): number {
  let n = 0;
  const visit = (list: readonly Stmt[]): void => {
    for (const s of list) {
      switch (s.k) {
        case "break":
        case "continue":
          if (s.label === label) n++;
          break;
        case "if":
          visit(s.then);
          visit(s.else);
          break;
        case "while":
        case "do-while":
        case "for":
        case "for-in":
        case "for-of":
        case "labeled":
          visit(s.body);
          break;
        case "try":
          visit(s.block);
          visit(s.handler);
          if (s.finalizer !== undefined) visit(s.finalizer);
          break;
        case "switch":
          for (const c of s.cases) visit(c.body);
          break;
        default:
          break;
      }
    }
  };
  visit(stmts);
  return n;
}

function isBreak(s: Stmt | undefined, label: string): boolean {
  return s !== undefined && s.k === "break" && s.label === label;
}

/** `lead…; rX = V` (all `expr` statements) -> the single expression it
 *  evaluates and the register it writes. `[]` -> `null` value (bare arm). */
function collapseArm(stmts: readonly Stmt[]): { readonly target: string | null; readonly value: Expr | null } | null {
  if (stmts.length === 0) return { target: null, value: null };
  if (!stmts.every((s) => s.k === "expr")) return null;
  const last = stmts[stmts.length - 1] as Extract<Stmt, { k: "expr" }>;
  if (last.expr.k !== "assign" || last.expr.target.k !== "ident" || !isRegisterName(last.expr.target.name)) return null;
  const lead = stmts.slice(0, -1).map((s) => (s as Extract<Stmt, { k: "expr" }>).expr);
  // An arm that needs a comma sequence AND already holds a join (an inner
  // site this rung recovered, or any other `?:`/`&&`/`||`) stays a
  // statement: folding it would only trade the label for an unreadable
  // nested comma expression, and the round trip does not need it — the
  // inner expression's join block is what hermesc has to see (spec §1).
  if (lead.length > 0 && [...lead, last.expr.value].some(hasJoin)) return null;
  const value = lead.length === 0 ? last.expr.value : ({ k: "seq", exprs: [...lead, last.expr.value] } as Expr);
  return { target: last.expr.target.name, value };
}

function hasJoin(e: Expr): boolean {
  let found = false;
  walk([{ k: "expr", expr: e }], {
    expr: (x) => {
      if (x.k === "cond" || x.k === "logical") found = true;
    },
  });
  return found;
}

function isIdent(e: Expr, name: string): boolean {
  return e.k === "ident" && e.name === name;
}

/** `T ? A : B`, printed the way hermesc lowers it back: a `!c` test is
 *  stripped by swapping the arms (exact: `!c` is truthy iff `c` is falsy),
 *  then `x ? x : B` is `x || B` and `x ? A : x` is `x && A`. */
export function joinExpr(test: Expr, a: Expr, b: Expr): Expr {
  if (test.k === "unary" && test.op === "!") return joinExpr(test.arg, b, a);
  if (test.k === "ident" && isIdent(a, test.name)) return { k: "logical", op: "||", left: test, right: b };
  if (test.k === "ident" && isIdent(b, test.name)) return { k: "logical", op: "&&", left: test, right: a };
  return { k: "cond", test, then: a, else: b };
}

function declares(s: Stmt): boolean {
  return s.k === "decl" || s.k === "init" || s.k === "func" || s.k === "classdecl";
}

export function parseSite(list: readonly Stmt[], index: number): ValueJoinSite | null {
  const lab = list[index];
  if (lab === undefined || lab.k !== "labeled") return null;
  // Only a join that feeds straight into another jump: the block after `L`
  // is a `break`/`continue`, so the original's join block held nothing but
  // that jump — the jump-to-jump block only an expression join leaves behind
  // (spec §1). Anywhere else the statement form already recompiles the same
  // (an if-statement's join is not empty) and the expression form would not:
  // a value join used as an `if` test, a chained `(a && b) || c`, a hoisted
  // constant arm.
  const next = list[index + 1];
  if (next === undefined || (next.k !== "break" && next.k !== "continue")) return null;
  const body = lab.body;
  const L = lab.label;
  if (!isBreak(body[body.length - 1], L)) return null;
  // The guard: the last `if` in the body with no else whose then-arm ends in
  // `break L`; everything after it must be the else arm's `expr` run.
  let g = -1;
  for (let i = body.length - 2; i >= 0; i--) {
    if (body[i]!.k === "if") {
      g = i;
      break;
    }
  }
  if (g < 0) return null;
  const guard = body[g] as Extract<Stmt, { k: "if" }>;
  if (guard.else.length !== 0 || !isBreak(guard.then[guard.then.length - 1], L)) return null;
  if (labelUses(body, L) !== 2) return null; // the guard's break and the tail break, nothing else
  const pre = body.slice(0, g);
  if (pre.some(declares)) return null;
  const thenArm = collapseArm(guard.then.slice(0, -1));
  const elseArm = collapseArm(body.slice(g + 1, -1));
  if (thenArm === null || elseArm === null) return null;
  const target = elseArm.target ?? thenArm.target;
  if (target === null) return null; // neither arm writes a value
  if ((thenArm.target !== null && thenArm.target !== target) || (elseArm.target !== null && elseArm.target !== target)) return null;
  const rX: Expr = { k: "ident", name: target };
  const value = joinExpr(guard.test, thenArm.value ?? rX, elseArm.value ?? rX);
  return { index, pre, target, value };
}

export function match(list: readonly Stmt[], ctx: PassContext): ValueJoinMatch | null {
  for (let i = 0; i < list.length; i++) {
    const site = parseSite(list, i);
    if (site !== null) return { root: list, nodes: [list], data: site, at: { functionIndex: ctx.functionIndex, offset: i } };
  }
  return null;
}
