// Guarded try ladders: a deep nest of `__pc`-guarded `try`/`catch` printed
// as ONE `try` whose `catch` picks the handler with an `if`/`else if` chain.
//
// A function with many exception regions whose `try` extents over-reach
// (src/structure/augment.ts; the guard is in src/emit/function.ts) prints as
// a nest, one `try` per region, innermost region innermost:
//
//   try { try { BODY } catch (_e1) { if (!(G1)) throw _e1; __exc = _e1; break L0; } }
//   catch (_e0) { if (!(G0)) throw _e0; __exc = _e0; break L0; }
//
// That is exact, but the Hermes compiler's optimiser (`hermes`/`hermesc`
// with the default -O, i.e. source mode and a release build) needs memory
// superlinear in the nesting depth times the live variables: a hbc99 lowered
// generator with 247 nested regions (bare RN 0.88 app, fn#37772) made it
// exceed 18 GB and abort with "LLVM ERROR: out of memory" (fixture 500 is the
// small repro). When every handler is a pure guard followed by statements
// that cannot throw (plain assignments of names/literals, break, continue),
// the nest is equivalent to
//
//   try { BODY } catch (_e1) { if (G1) { __exc = _e1; break L0; } else if (G0) { __exc = _e1; break L0; } else throw _e1; }
//
// because an inner handler can only leave by its guard's rethrow (to the next
// outer catch, unchanged value, `__pc` unchanged) or by its non-throwing tail,
// and each outer `try` block holds nothing but the inner `try`. Shallow nests
// keep their shape (LADDER_MIN), so ordinary output is unchanged.
import type { Expr, Stmt } from "./ast.ts";
import { id, un } from "./ast.ts";

/** Nests shallower than this print as before. */
export const LADDER_MIN = 16;

interface Arm {
  /** When this arm's handler owns the exception. */
  readonly test: Expr;
  /** Its handler after the guard, with the catch binding still `param`. */
  readonly rest: readonly Stmt[];
  readonly param: string;
}

interface Chain {
  /** Innermost region first: the order an exception is offered in. */
  readonly arms: readonly Arm[];
  readonly inner: readonly Stmt[];
}

const chains = new WeakMap<Stmt, Chain>();

function pureTest(e: Expr): boolean {
  switch (e.k) {
    case "ident":
    case "lit":
      return true;
    case "unary":
      return e.op === "!" && pureTest(e.arg);
    case "bin":
      return (e.op === ">=" || e.op === "<=" || e.op === ">" || e.op === "<" || e.op === "===" || e.op === "!==") && pureTest(e.left) && pureTest(e.right);
    case "logical":
      return pureTest(e.left) && pureTest(e.right);
    default:
      return false;
  }
}

function simpleTail(s: Stmt): boolean {
  if (s.k === "break" || s.k === "continue") return true;
  if (s.k !== "expr" || s.expr.k !== "assign") return false;
  const { target, value } = s.expr;
  return target.k === "ident" && (value.k === "ident" || value.k === "lit");
}

function renameParam(s: Stmt, from: string, to: string): Stmt {
  if (from === to || s.k !== "expr" || s.expr.k !== "assign" || s.expr.value.k !== "ident" || s.expr.value.name !== from) return s;
  return { ...s, expr: { ...s.expr, value: id(to) } };
}

/**
 * The `try` for one guarded region: `try { block } catch (param) { if
 * (!(owns)) throw param; ...rest }`, or, when `block` is exactly a guarded
 * nest this module built and the whole nest is LADDER_MIN deep, the
 * flattened form above.
 */
export function guardedTry(block: readonly Stmt[], param: string, owns: Expr, rest: readonly Stmt[]): Stmt {
  const handler: Stmt[] = [{ k: "if", test: un("!", owns), then: [{ k: "throw", arg: id(param) }], else: [] }, ...rest];
  const nested: Stmt = { k: "try", block, param, handler };
  if (!pureTest(owns) || !rest.every(simpleTail)) return nested;
  const arm: Arm = { test: owns, rest, param };
  const child = block.length === 1 ? chains.get(block[0]!) : undefined;
  const chain: Chain = child !== undefined ? { arms: [...child.arms, arm], inner: child.inner } : { arms: [arm], inner: block };
  if (chain.arms.length < LADDER_MIN) {
    chains.set(nested, chain);
    return nested;
  }
  const p = chain.arms[0]!.param;
  let tail: Stmt[] = [{ k: "throw", arg: id(p) }];
  for (let i = chain.arms.length - 1; i >= 0; i--) {
    const a = chain.arms[i]!;
    const elseIf = tail.length === 1 && tail[0]!.k === "if";
    tail = [{ k: "if", test: a.test, then: a.rest.map((s) => renameParam(s, a.param, p)), else: tail, ...(elseIf ? { elseIf: true } : {}) }];
  }
  const flat: Stmt = { k: "try", block: chain.inner, param: p, handler: tail };
  chains.set(flat, chain);
  return flat;
}
