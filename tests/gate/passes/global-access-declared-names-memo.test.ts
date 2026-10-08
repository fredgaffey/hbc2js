// Regression test: `declaredNames`
// (`src/passes/global-access/match.ts`) used to rebuild a whole-body
// `Set<string>` from scratch on every call, so `classifySite`'s per-candidate
// `isShadowed` check re-walked the entire function body once per candidate
// guard, which dominated whole-file decompile time on large functions.
//
// This pins the fix as a COUNTED invariant rather than a wall-clock one
// (wall-clock assertions flake under load):
// `declaredNames` must return the *same* `Set` object -- not just an
// equal one -- for two calls on the same statement-list identity, which is
// only possible if the second call was served from a cache instead of
// recomputing. A fresh statement array with the same contents must NOT
// share that identity, proving the cache key is the list's own identity and
// not its contents (which is what makes it sound: stage-B statement lists
// are never mutated in place, only replaced -- see the correctness comment
// on `declaredNamesMemo` in `match.ts`, and its precedent `registerUsesMemo`
// in `src/passes/ast.ts`).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Stmt } from "../../../src/emit/ast.ts";
import { declaredNames } from "../../../src/passes/global-access/match.ts";

const declStmt = (names: readonly string[]): Stmt => ({ k: "decl", kind: "let", names });

test("declaredNames memoises on statement-list identity: same array -> same Set object", () => {
  const body: readonly Stmt[] = [declStmt(["x", "y"])];

  const first = declaredNames(body);
  const second = declaredNames(body);

  assert.strictEqual(first, second, "declaredNames must return the exact same Set instance for the same list identity (i.e. computed once, not once per call)");
  assert.deepStrictEqual([...first].sort(), ["x", "y"]);
});

test("declaredNames does not share cache entries across two lists with equal contents but different identity", () => {
  const bodyA: readonly Stmt[] = [declStmt(["x"])];
  const bodyB: readonly Stmt[] = [declStmt(["x"])];

  const a = declaredNames(bodyA);
  const b = declaredNames(bodyB);

  assert.notStrictEqual(a, b, "two distinct array identities must not collapse to one cache entry, even with identical contents");
  assert.deepStrictEqual([...a], [...b]);
});

test("declaredNames called many times for many candidates on one body is served from one cached Set (counted, not wall-clock)", () => {
  const body: readonly Stmt[] = [declStmt(["a", "b", "c"])];
  const sets = new Set<Set<string>>();
  for (let i = 0; i < 50; i++) sets.add(declaredNames(body));

  assert.strictEqual(sets.size, 1, `expected every one of 50 candidate-style calls on the same body to reuse one cached Set, got ${sets.size} distinct Set instances`);
});
