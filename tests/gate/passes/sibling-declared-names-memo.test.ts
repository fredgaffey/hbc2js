// Regression test: there are three OTHER copies of `declaredNames` with the same
// whole-body-walk shape as `global-access/match.ts`'s (which is memoised) -- `var-naming/match.ts`, `reg-split/match.ts` and
// `fn-naming/match.ts` -- and memoising them is only
// correct "if the same identity-immutability holds there" (unverified so
// far, on purpose).
//
// It does (see the correctness comment on each
// file's own `declaredNamesMemo`: `declaredNames` in all three is a pure
// function of the statement-list argument alone -- no `ctx.applied`,
// module-level counter or naming overlay is consulted -- so the same
// argument as `registerUsesMemo`/global-access's `declaredNamesMemo`
// applies: stage-B statement lists are only ever replaced wholesale, never
// mutated in place, so a `WeakMap<readonly Stmt[], Set<string>>` keyed on
// list identity can never observe a stale entry).
//
// Pinned as a COUNTED invariant (same object identity across repeated
// calls), not wall-clock -- wall-clock assertions have flaked on both
// machines. Mirrors
// `tests/gate/passes/global-access-declared-names-memo.test.ts` for the
// other three copies.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Stmt } from "../../../src/emit/ast.ts";
import { declaredNames as varNamingDeclaredNames } from "../../../src/passes/var-naming/match.ts";
import { declaredNames as regSplitDeclaredNames } from "../../../src/passes/reg-split/match.ts";
import { declaredNames as fnNamingDeclaredNames } from "../../../src/passes/fn-naming/match.ts";

const declStmt = (names: readonly string[]): Stmt => ({ k: "decl", kind: "let", names });

for (const [label, declaredNames] of [
  ["var-naming", varNamingDeclaredNames],
  ["reg-split", regSplitDeclaredNames],
  ["fn-naming", fnNamingDeclaredNames],
] as const) {
  test(`${label}'s declaredNames memoises on statement-list identity: same array -> same Set object`, () => {
    const body: readonly Stmt[] = [declStmt(["x", "y"])];

    const first = declaredNames(body);
    const second = declaredNames(body);

    assert.strictEqual(first, second, `${label}'s declaredNames must return the exact same Set instance for the same list identity (i.e. computed once, not once per call)`);
    assert.deepStrictEqual([...first].sort(), ["x", "y"]);
  });

  test(`${label}'s declaredNames does not share cache entries across two lists with equal contents but different identity`, () => {
    const bodyA: readonly Stmt[] = [declStmt(["x"])];
    const bodyB: readonly Stmt[] = [declStmt(["x"])];

    const a = declaredNames(bodyA);
    const b = declaredNames(bodyB);

    assert.notStrictEqual(a, b, `${label}'s declaredNames must not collapse two distinct array identities into one cache entry, even with identical contents`);
    assert.deepStrictEqual([...a], [...b]);
  });

  test(`${label}'s declaredNames called many times for many candidates on one body is served from one cached Set (counted, not wall-clock)`, () => {
    const body: readonly Stmt[] = [declStmt(["a", "b", "c"])];
    const sets = new Set<Set<string>>();
    for (let i = 0; i < 50; i++) sets.add(declaredNames(body));

    assert.strictEqual(sets.size, 1, `expected every one of 50 candidate-style calls on the same ${label} body to reuse one cached Set, got ${sets.size} distinct Set instances`);
  });
}
