# 31 — `array-literal` (stage B, catalogue row **31**)

Rebuild `r3 = new Array(2); r3[0] = a; r3[1] = b;` back into `r3 = [a, b]`.

Evidence: `docs/lowering/array-literal.md` (v94 and v99 dumps of
`tests/fixtures/constructs/84-array-literal`). Fixture: `84-array-literal`.
Array literals lower to `new Array(n)` followed by per-index stores; `object-literal` handles the object side only.

## 1. Purpose

`object-literal`'s own comment already named the gap: its `OWN_DEFINE` set
deliberately excludes `DefineOwnInDenseArray…` as "array literals, a
different rung's job". `NewArray`/`NewFastArray` is not in its
`FRESH_OBJECT` set either. This rung is that job: an array literal with at
least one non-constant element lowers to an intrinsic allocation plus a run
of own-index stores, and the M4 baseline prints that literally — a
constructor call plus one indexed assignment per element, where the source
had one literal.

Correctness is not at stake — the rung only changes *how* the same array is
built. Unlike `object-literal`, it does not fold a prefix when the rest is
unfoldable: array elements have no name to re-anchor a partial literal to,
and a partial run is exactly the shape a trailing elision (`[a, b, ,]`)
produces, which must stay untouched (never patched with a synthesized
`.length` store) rather than silently drop an element.

## 2. Baseline shape (measured, v94 and v99)

Full dump in `docs/lowering/array-literal.md`. In one line: `NewArray rD, k`
(or `NewFastArray`) then, for each non-constant element in source order, one
`PutOwnByIndex`/`…L` (v94-family) or `DefineOwnByIndex`/`…L`/
`DefineOwnInDenseArray`/`…L` (v99-family) at indices `0..k-1`, contiguous.

The decisive measurement (full detail in the evidence file): once the array
is not built entirely by literal syntax — `k=0`, or any index assigned as a
*separate* statement after the literal — every later index store compiles
to `PutByVal`/`PutByValLoose`/`PutByValStrict` instead, a full `[[Set]]`,
**regardless of whether it is a first write or a redefinition, and
regardless of whether its value reads the array itself**. This is the one
place arrays and objects genuinely differ: `o.a = 1;` after `{}`, as a
*separate* statement, still compiles to `PutNewOwnById`. Arrays have no
own-index opcode family outside the literal's own bracket syntax.

A fully-constant literal (`[1, 2, 3]`) lowers straight to
`NewArrayWithBuffer`/`…Long`, which `src/emit/literals.ts` already renders
as an `array` node — out of scope here (precondition 6).

## 3. AST the rung owns

None. It writes `{ k: "array", elements }` (`src/emit/ast.ts`), which
already exists for `NewArrayWithBuffer`. No framework AST change.

Same framework prerequisites as `object-literal`: `originOf`/`opcodeAt`
(`src/passes/ast.ts`), already built.

## 4. Matcher — preconditions

`match(list, ctx)` scans for the first index `i` at which:

1. **Fresh array allocation.** `list[i]` is `rN = new Array(k)` / `new
   Array()`-equivalent (`{k:"new", callee: Array, fromNewArray: true}`) with
   `rN` a register name and a single literal integer argument `k`. A
   source-level `new Array(x)` never carries `fromNewArray` (it is a
   `GetGlobalObject` read plus `Construct`) and is refused outright — this
   is a provenance check, not a shape check, exactly like `literal-forms`'s
   `fromRegExpTable`.
2. **Store opcode is an own-index define.** `PutOwnByIndex`/`…L`,
   `DefineOwnByIndex`/`…L`, `DefineOwnInDenseArray`/`…L` only.
   `PutByVal`/`PutByValLoose`/`PutByValStrict` end the run: full `[[Set]]`,
   walks the prototype chain (and, per §2's measurement, is what every
   store outside the literal's own syntax compiles to anyway — refusing it
   costs nothing real).

   **The interleaved case (`array-literal-interleaved`, docs/BUGS.md,
   2026-09-26).** A statement between two own-index stores is not an
   automatic refusal: it first tries to commute above the whole run
   collected so far, via `object-literal`'s own `canHoist` commutation
   proof (docs/specs/passes/20-object-literal.md §4), ported unchanged
   (same three conditions, `reg` is the array's register instead of the
   object's — `src/passes/array-literal/match.ts`'s own `canHoist`/
   `freshRegisterDef` doc comments have the restated proof). It only ends
   the run there if it cannot. Measured building fixture
   `85-array-literal-interleaved` (all five hermesc versions): Hermes's
   register allocator reuses a scratch register the moment it is freed, and
   within one array literal's own element evaluation a register becomes
   free by being *read* as an earlier element's own value — so a *second*
   arithmetic element needing its own scratch register almost always
   reuses a register an earlier element already read, which `canHoist`'s
   precondition 1 (the candidate's target register must be read nowhere
   earlier in the run) correctly refuses to hoist. This is F1's
   `non-own-index-store` + `partial-run` dominant real-world shape
   and it is UNCHANGED by this rung's own extension —
   see `nonHoistable` in the fixture. The case that DOES commute in real
   bytecode is a *reference* copy needing no computation at all (an
   already-created nested closure's reference moved into a fresh scratch
   register nothing before it has touched — `hoistable` in the fixture).
3. **Strictly ascending, no gap, no repeat.** The store at `list[i+1+m]`
   must be at index exactly `m`. A gap (`holedLiteral`, index sequence
   `0, 2`) ends the run at the gap.
4. **The value does not read or write `rN`.** `identUses(value, rN)` must be
   zero reads and zero writes. Measured unreachable via any straightforward
   source (§2): every own-index store is part of the literal's own bracket
   syntax, evaluated before `rN` is exposed anywhere. Kept as a defensive
   precondition and covered by a synthetic matcher unit test rather than a
   fixture case, the same way some of `object-literal`'s own preconditions
   are defense-in-depth against a shape no real construct has produced yet.
5. **Exactly `k` elements, no more, no fewer.** If the contiguous run ends
   (opcode mismatch, index mismatch, end of list, or precondition 4) before
   `k` elements are collected, the WHOLE site is refused — nothing folds,
   not even the elements that were collected. This is `array-literal`'s one
   deliberate divergence from `object-literal`'s "fold the foldable prefix"
   behaviour: a partial array literal has no key to re-anchor an element to
   if the run is cut short, and patching the gap with a synthesized
   `.length = k` store would silently manufacture a hole the original
   bytecode never signalled at the fold site.
6. **`NewArrayWithBuffer`/`…Long` excluded.** Checked by construction:
   `defOf` only recognises `{k:"new", fromNewArray:true}`, which
   `NewArrayWithBuffer` never produces (it lowers straight to an `array`
   node — §2). A `sizeHint > count` `.length` store on one of those is
   therefore never in scope either.

`k=0` with no stores is a match with zero elements (`[]`) — precondition 5
holds trivially (0 collected, 0 required).

## 5. Writer

`list[0…i-1]` ++ `hoisted` ++ `[{...list[i], expr: rN = [elements]}]` ++
`list[i+1+span…]` where `span = count + hoisted.length`.

The definition statement is spread, not rebuilt, so the `NewArray`
instruction's `origin` stamp survives onto the rebuilt literal. `hoisted`
statements (§4's interleaved-case extension) are relocated verbatim, in
their original relative order, directly before the rebuilt literal — never
deleted, never rewritten (same pattern as `object-literal`'s own writer).

## 6. Checker

Recompute-and-diff, the `object-literal` pattern: `check` re-runs the real
matcher on `before`, never the driver's captured data, then asserts

1. `after.length === before.length - count` (`hoisted` statements survive,
   so only the folded stores are removed);
2. every statement before the definition is reference-identical to its
   `before` counterpart; every `hoisted` statement appears, verbatim and in
   order, immediately before the rebuilt literal; every statement after the
   run is reference-identical to its `before` counterpart;
3. `after[defIndex + hoisted.length]` is `rN = <array>` for the recomputed
   `rN`;
4. the written element list is, element for element, the recomputed one:
   same length, same order, each structurally equal to the store's own
   value expression;
5. no written element mentions `rN` (precondition 4 restated on the
   output);
6. `parses(after)` (run once per (pass, function) by the stage-B driver,
   not per site — same cost reasoning as `object-literal`'s checker).

## 7. Ordering, refusals, fixtures

**Ordering.** `after: ["expr-rebuild", "global-access", "call-shape"]`,
`before: ["jsx-recover", "var-naming"]`; registered immediately after
`object-literal` in `src/passes/registry.ts` — same stage-B
structure-recovery block, same dependency reasoning (a store's value is
only an expression once `expr-rebuild` has run; the deleted register must
never have been named by `var-naming`; a folded array is a plausible
`jsx-recover` children shape).

**Refusal table** (fixture `84-array-literal`):

| case | shape | precondition refused |
|---|---|---|
| `normalFold` | full 0..k-1 run | (none — folds) |
| `empty` | `k=0`, no stores | (none — folds to `[]`) |
| `partialRun` | trailing elision, 2 of 3 stores | 5 (partial run) |
| `ctorNew` | source-level `new Array(x)` | 1 (no `fromNewArray`) |
| `selfReferencingStore` | post-creation index stores | 2 (`PutByVal`, not an own-index opcode) |
| `holedLiteral` | middle hole, indices 0, 2 | 3 (gap) |

**Fixtures.** `tests/fixtures/constructs/84-array-literal` (v84/94/96/98/99).
Unit tests (`tests/gate/passes/array-literal.test.ts`) cover the same six
shapes on hand-built ASTs plus a synthetic precondition-4 case (§4 item 4)
and the checker-rejects-a-mutated-writer pattern.

**The interleaved case, fixture `85-array-literal-interleaved`**
(v84/94/96/98/99, docs/BUGS.md `array-literal-interleaved`):

| case | shape | outcome |
|---|---|---|
| `hoistable` | a nested closure's reference copied into a fresh scratch register between the definition and the first element store | folds — the copy commutes above the whole run |
| `nonHoistable` | a second arithmetic element's reload reuses a register an earlier element already read | refused, unchanged from before this extension (`non-own-index-store` then `partial-run`, F1's dominant real shape) |

Unit tests (`tests/gate/passes/array-literal.test.ts`) cover `canHoist` on
hand-built ASTs directly, mirroring `object-literal`'s own precedent
(`docs/specs/passes/20-object-literal.md` §4's `canHoist` positive case is
likewise validated only by hand-built-AST unit tests, not by its own
construct fixture): a pure register def hoists; a candidate that reads the
half-built array, one with an effect (a call), and a register redefinition
an earlier fold already read all correctly refuse to hoist.

## 8. Element-expression folding ceiling
Before more code was written, the question was: of the sites §7's `non-own-index-store`/`partial-run` refusals still
leave unfolded, how many are blocked *specifically* because an element's
value is a bare register read whose own definition (a pure expression) sits
interleaved in the same run, rather than already inlined by `expr-rebuild`
(the register-reuse hazard §7's own table calls `nonHoistable`)? That
number is the ceiling on a possible follow-up step ("element-expression
folding": substitute the definition directly into the store's own value, in
place, instead of trying to hoist the whole statement).

`tools/passes/array-literal-fold-ceiling.ts` answers this by running the
real stage-B pipeline to its real fixed point (only `fn-naming`/`reg-split`/
`var-naming` skipped — the pure-renaming block, which runs strictly *after*
`array-literal`'s own fixed point and so cannot change any of its
decisions, but whose `reg-split` step would otherwise pre-disambiguate the
exact reused registers this measurement needs to see collided) and
classifying every surviving `new Array(k)` site (the denominator) as:

- **closes-with-fold**: every element the site needs exists as an
  own-index store, and every element whose value is a bare register read
  has a definition found *within the same statement list* `array-literal`
  itself matches over that is (a) `rX = <pure expression>` (`isPure`, the
  same test `canHoist` already uses) and (b) read nowhere else in that
  list — substituting it directly into the store's value, in place, turns
  the site into a fully contiguous run with nothing left over.
- **undecidable**: at least one such bare-register element's definition is
  not found anywhere in the local statement list at all (an outer scope, a
  parameter, a preceding sibling block) — this tool's local analysis
  cannot soundly say whether it is pure or single-use.
- **blocked**: everything else (an index gap/repeat, a self-referencing
  store, a non-store/non-fold-candidate interleaved statement, a
  definition that exists locally but is impure or used more than once, or
  a leftover definition nothing ever consumes) — decidably not fixed by
  element-expression folding alone.

**Measured**, both builds of react-navigation-example-0.85.3
(pinned in
`tests/gate/passes/array-literal-fold-ceiling.test.ts`) — RELEASE
(`react-navigation-example.hbc`) and DEBUG (`react-navigation-example.debug
.hbc`) give the *identical* split: 926 unfolded sites, 3 close-with-fold
(**0.3%**), 892 blocked (96.3%), 31 undecidable (3.3%).

**Conclusion: the ceiling is well under the 30% threshold set for step
2 (0.3%, not "> 30%") on the measured target.** Step 2 ("fold those
definitions into the store's RHS in expr-rebuild") is **not warranted** by
this data — the register-reuse hazard §7 already found ("Hermes's register
allocator reuses a scratch register the moment it is freed") turns out to
almost always involve either a genuinely undecidable-locally register (most
of the small undecidable share) or a register that is *not* actually
single-use/pure once the whole interleaved run is accounted for (the
overwhelming `blocked` majority) — not the narrow "one clean single-use
pure definition, immediately consumed" shape this ceiling measures. No
further array-literal work is queued by this finding.
