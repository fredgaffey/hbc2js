# 32 — value-join: `||` / `&&` / `?:` value joins

Status: shipped (stage B rung `value-join`, `src/passes/value-join/`).
Acceptance: fixture `280-value-join-logical`, `tests/gate/passes/value-join.test.ts`.

## 1. Problem

An `||`, `&&` or `?:` whose value is assigned to one register decompiles to
a labelled block with a guard `break`:

    L: { pre…; if (T) { [lead…; rX = A;] break L; } lead…; rX = B; break L; }

Correct, but not what hermesc compiled. hermesc's IRGen gives a conditional
*expression* a join block that carries the phi; an if-statement's join is an
empty block (the values live in stack slots until mem2reg), which
SimplifyCFG threads away. When the join feeds an enclosing join (a ternary in
one arm of an if/else, `return f ? g() : x || ""`), the original keeps a
jump-to-jump block (`L1: Jmp L3`) and the statement-form recompile does not,
so every later label shifts. On the Expensify round trip this was the real
cause behind the `diff:JmpFalse(label)` / `diff:JmpTrue(label)` buckets once
the globalThis-read artefacts (another bucket's cause, surfacing at the first
conditional jump) are set aside.

## 2. Choice

Rewrite the labelled block to `pre…; rX = <join>;` and drop the label, where
`<join>` is `T ? (lead…, A) : (lead…, B)` with a bare `break` arm meaning
`rX` itself. Printed the way hermesc lowers it back: a `!c` test strips the
`!` by swapping arms (exact for any `c` — truthiness, not a relational
rewrite, so `!(a < b)` never becomes `a >= b`), then `x ? x : B` is
`x || B` and `x ? A : x` is `x && A`. Preconditions: the label has exactly the
two uses, both arms are `expr` runs ending in an assignment to the same
register, nothing in the block declares a binding (the body is spliced into
the parent list). Exact: the same expressions run in the same order on both
paths and `rX` gets the same final value. An arm that needs a comma sequence
and already contains a join is refused — the inner expression's join block is
what the round trip needs; folding the outer one too only buys an unreadable
nested comma expression.

## 3. Rejected alternative

Reordering if/else arms or inverting branch polarity in the structurer. The
original and recompiled sequences agree on polarity and arm order; what
differs is one unthreaded block, which only the expression form reproduces.
`check` recomputes the site from `before` and compares the written list.
