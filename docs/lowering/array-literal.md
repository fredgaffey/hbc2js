# Array literal with non-constant values (catalogue row 31)

Measured directly with `tools/hermesc/v94/hermesc -dump-bytecode` and
`tools/hermesc/v99/hermesc -dump-bytecode` against the probe below (same
method as [object-literal.md](object-literal.md) row 28; the probe predates
`tests/fixtures/constructs/84-array-literal/source.js`, which is the
committed, gate-enrolled version of the same six shapes).

## Source

```js
function normalFold(a, b, c) { return [a + 1, b * 2, c]; }
function empty() { return []; }
function partialRun(a, b) { return [a, b, ,]; }
function ctorNew(x) { return new Array(x); }
function selfReferencingStore(a) {
  var arr = [];
  arr[0] = a;
  arr[1] = arr[0] + 1;
  return arr;
}
function holedLiteral(a, b) { return [a, , b]; }
```

## v94 (`NewArray` + `PutOwnByIndex`)

```
Function<normalFold>:
    NewArray          r0, 3
    PutOwnByIndex     r0, r1, 0
    PutOwnByIndex     r0, r1, 1
    PutOwnByIndex     r0, r1, 2

Function<empty>:
    NewArray          r0, 0

Function<partialRun>:
    NewArray          r0, 3
    PutOwnByIndex     r0, r1, 0
    PutOwnByIndex     r0, r1, 1
    ; (only 2 of 3 -- a trailing elision drops the third store)

Function<ctorNew>:
    GetGlobalObject   r0
    ...
    Construct         r0, r2, 2
    ; no NewArray at all -- a source-level `new Array(x)` is an ordinary
    ; global-object read plus Construct, never fromNewArray

Function<selfReferencingStore>:
    NewArray          r0, 0
    ...
    PutByVal          r0, r1, r2   ; arr[0] = a
    ...
    PutByVal          r0, r2, r1   ; arr[1] = arr[0] + 1

Function<holedLiteral>:
    NewArray          r0, 3
    PutOwnByIndex     r0, r1, 0
    PutOwnByIndex     r0, r1, 2
    ; (index 1 is skipped -- a gap, not a trailing partial run)
```

## v99 (`NewArray` + `DefineOwnInDenseArray`)

Identical shape, `PutOwnByIndex` -> `DefineOwnInDenseArray`, `PutByVal` ->
`PutByValLoose`:

```
Function<normalFold>:
    NewArray              r1, 3
    DefineOwnInDenseArray r1, r2, 0
    DefineOwnInDenseArray r1, r0, 1
    DefineOwnInDenseArray r1, r2, 2

Function<selfReferencingStore>:
    NewArray          r1, 0
    PutByValLoose     r1, r0, r2
    PutByValLoose     r1, r0, r2
```

## The decisive measurement

Once an array is not built entirely by literal syntax -- `k=0` (`empty`,
`selfReferencingStore`'s starting point), or any index assigned as a
*separate* statement after the literal -- every later index store compiles
to `PutByVal`/`PutByValLoose`/`PutByValStrict` (a full `[[Set]]`), never to
an own-index opcode, **regardless of whether it is the first write to that
index or a redefinition, and regardless of whether its value reads the
array itself**. This is the one place arrays and objects genuinely differ:
`o.a = 1;` as a *separate* statement after `{}` still compiles to
`PutNewOwnById` (`docs/lowering/object-literal.md`), because an own-property
define is a first-class opcode family for any first write to a data key —
arrays have no such family outside the literal's own bracket syntax. The
practical consequence: a "self-referencing element" and a "`PutByVal`
source" are the same construct in real bytecode (`selfReferencingStore`
above is both at once); the array-literal rung's precondition against a
self-referencing own-index store's value is unreachable via any
straightforward source and is covered by a synthetic matcher unit test
instead (`tests/gate/passes/array-literal.test.ts`), the same way
`object-literal`'s own defensive preconditions are.

A fully-constant literal (`[1, 2, 3]`) lowers straight to
`NewArrayWithBuffer`/`NewArrayWithBufferLong`, which `src/emit/literals.ts`
renders as an `array` node directly — out of scope for this rung
(precondition 6), the same way `NewObjectWithBuffer`'s fully-constant case
needs no rung either.

**Pass `array-literal` (stage B)** — `src/passes/array-literal/`,
`docs/specs/passes/31-array-literal.md`.
