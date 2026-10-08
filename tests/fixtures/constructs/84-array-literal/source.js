// Array literals with at least one non-constant element lower to
// `NewArray`/`NewFastArray` (carrying `fromNewArray`) followed by a
// contiguous run of own-index defines (`PutOwnByIndex`/`DefineOwnByIndex`/
// `DefineOwnInDenseArray`). Nothing folds that back — docs/specs/passes/
// 31-array-literal.md is the rung that does. A fully-constant literal
// (`[1, 2, 3]`) is not this rung's job: it already lowers straight to
// `NewArrayWithBuffer`, which `src/emit/literals.ts` renders as `array`
// directly (excluded by precondition 6 below).

// A -- plain run, non-constant values, indices 0..2 exactly: folds.
//
// Measured directly (all five hermesc versions): elements must be BARE
// identifiers (or anything else already resident in a register with
// nothing else needing to run before the array is created) for this to
// fold under the outline's stated scope. An arithmetic element
// (`a + 1`) computes its value into a fresh register BEFORE `NewArray`
// even runs (Hermes hoists array creation past a computed first element,
// since allocation has no observable side effect), and every element
// after the first needs its own fresh register load immediately before
// its own store -- both are genuine interleaved statements the matcher
// (deliberately, per the outline's "out of scope: the interleaved case")
// does not hoist, so a version of this function using `a + 1` etc.
// refuses at EVERY version, not just some. See this rung's report / the
// array-literal-interleaved follow-up row.
function normalFold(a, b, c) {
  return [a, b, c];
}

// B -- k = 0, no stores: folds to `[]`.
function empty() {
  return [];
}

// C -- NEGATIVE control: a trailing elision (`[a, b, ,]`) compiles to
// `NewArray 3` but only two own-index stores (0, 1) -- a contiguous,
// ascending, but PARTIAL run (elements.length !== k). Refused, never
// patched with a `.length` store (precondition 5).
function partialRun(a, b) {
  return [a, b, ,];
}

// D -- NEGATIVE control: a source-level `new Array(x)` is a global-object
// read plus `Construct`, never `NewArray`/`fromNewArray` -- refused before
// the matcher even looks at what follows (precondition 1).
function ctorNew(x) {
  return new Array(x);
}

// E -- NEGATIVE control: measured directly (v94 and v99 hermesc). Once an
// array literal is empty (`k = 0`) or otherwise not fully built by literal
// syntax, EVERY subsequent index store -- first-time or not, self-
// referencing or not -- compiles to `PutByVal`/`PutByValLoose` (a full
// `[[Set]]`), never to an own-index opcode: unlike object property stores
// (`o.a = 1;` after `{}` still compiles to `PutNewOwnById`), Hermes never
// emits an own-index opcode for a store outside the literal's own bracket
// syntax. So a self-referencing element and a `PutByVal` source are the
// SAME construct in real bytecode -- this one fixture function covers both
// preconditions (2 and 4) the outline lists separately; precondition 4 (an
// own-index store's value reading the register being built) has no other
// reachable source shape and is covered instead by a synthetic matcher unit
// test in tests/gate/passes/array-literal.test.ts. Refused.
function selfReferencingStore(a) {
  var arr = [];
  arr[0] = a;
  arr[1] = arr[0] + 1;
  return arr;
}

// F -- NEGATIVE control: a hole in the MIDDLE (`[a, , b]`) compiles to
// `NewArray 3` with own-index stores at 0 and 2 -- present but non-
// ascending (a gap at index 1, distinct from C's trailing-partial shape).
// Refused (precondition 3). Holes are a follow-up row (out of scope here).
function holedLiteral(a, b) {
  return [a, , b];
}

const r1 = normalFold(1, 2, 3);
const r2 = empty();
const r3 = partialRun(1, 2);
const r4 = ctorNew(3);
const r5 = selfReferencingStore(5);
const r6 = holedLiteral(1, 2);
print(JSON.stringify([r1, r2, r3, r4, r5, r6]));
