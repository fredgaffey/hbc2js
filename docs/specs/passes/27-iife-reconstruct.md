# 27 — `iife-reconstruct`: putting an inlined IIFE back

Owner: `src/emit/iife-reconstruct.ts`.
Ruling: default-on, not opt-in.
Repro: `tests/fixtures/constructs/75-sibling-envs`, `tests/gate/emit/sibling-env-slots.test.ts`.

## 1. The idiom

`hermesc -O` splices an immediately-invoked function expression into its
caller but keeps the callee's OWN environment. A caller that inlined several of
them therefore ends up with several environments SIDE BY SIDE, all children of
the same scope — fixture 75 compiles to `CreateFunctionEnvironment` of 2, 1 and
3 slots in one function, and react-navigation-example module 681 / fn#683 has
thirteen. Block scopes cannot produce this: hermesc merges sibling block scopes
into the enclosing function environment (P-41's evidence). Inlining is the only
trigger, and an IIFE is the only source form that round-trips it.

## 2. What the step does

The emitter declares every environment a function owns as one flat
`let _e<env>_<slot>` list in the function's top scope, so a recompile gives
hermesc a single scope and one renumbered environment. For each owned
environment that passes every guard in section 4, this step instead:

1. removes that environment's slot names from the flat `let` prologue;
2. moves the hoisted `function _fn<n>` declarations that read only that
   environment out of the prologue;
3. replaces the contiguous run of body statements that mention the
   environment (its statement RANGE) with

       (function {
         let _e<env>_0, _e<env>_1, ...;
         function _fn<n> { ... }
         ...the range...
       });

4. hoists any `let` declared inside the range and read after it to a bare
   `let` immediately in front of the IIFE, leaving a plain assignment in place
   (fixture 75's `let r0 = undefined;` is the shape this exists for).

## 3. Why emit-side and not a stage-B rung

Two inputs decide the transform and neither survives into `src/passes`:

* the env graph — which `_e<env>_<slot>` names belong to one environment, and
  which environment is the PARENT of which (a parent is the function's own
  scope, never an inlined callee's);
* `closureCreationSites` / the emitter's hoisted-children list — whether a
  `function _fn<n>` in the prologue is a real child of this body or one this
  body only HOSTS for someone else (`src/emit/placement.ts`).

A rung would have to re-derive environment ownership from name spelling and
could not tell a hosted orphan from a child at all; moving a hosted orphan into
a wrapper makes its name unbound in the sibling that reads it
(`E_UNBOUND_IDENT`, measured: 227 functions lost before the guard existed).
The step is therefore a placement step in `src/emit`, run on the assembled
statement list at the end of `emitFunction`, before the AST passes.

## 4. Refusal table

Every refusal leaves the flat `let _e<env>_<slot>` prologue exactly as it was,
so refusing is never a behaviour change. Counts are per environment on
react-navigation-example-0.85.3 v98 (`--lenient-env`), 128 environments in 54
functions wrapped.

| Reason | Guard | rnav count |
|---|---|---|
| fewer than two owned environments | one environment IS the function's own scope; the flat prologue already round-trips it | not counted |
| `generator body` | a lowered generator's statements live in a re-entered same-frame closure | 0 |
| `no env-slot prologue` / `env-slot prologue shared with other names` | the `let` list could not be split cleanly | 0 |
| `parent of a sibling environment` | this environment is the parent of another owned one, so it is the function's own scope | 42 |
| `closure spans two environments` | a hoisted closure reads two of the function's environments; it can live in only one wrapper | 138 |
| `hosted closure cannot move into the range` | a closure that reads this environment is not created exactly once by this body (an orphan or a per-creation-context copy), so another function names it | 262 |
| `moved closure named from outside the range` | a closure that stays outside names one that would move in | 0 |
| `overlapping statement ranges` | two environments interleave, so neither is a contiguous run | 757 |
| `environment read outside the range` | a slot, or a sibling environment's slot, is touched outside the range — the wrapper would add a scope level to the parent chain (`diff:GetParentEnvironment/...`) | 75 |
| `return` | a `return` inside the range would return from the wrapper | 11 |
| `break out of range` / `continue out of range` | the target loop, switch or label is outside the range | 0 |
| `this` / `arguments` | rebound by the wrapper | 8 / 4 |
| `yield` / `await` | the wrapper is not a generator or async function | 0 |
| `raw text` | unanalysable statement | 0 |
| `var declared in the range` | `var` is function-scoped; the wrapper would change its scope | 0 |
| `<kind> declaration outlives the range` | a `const`/`function`/`class` declared inside is read after it and cannot be hoisted | 0 |

## 5. Tests

* `tests/gate/emit/sibling-env-slots.test.ts` — decompile fixture 75, recompile
  with hermesc v98/v99, assert the sizes of the environments created in the
  owning function and the slot immediates every reader loads are the original's.
  Both cases were skipped under P-41 and are green with this step.
* `tests/gate/emit/iife-reconstruct.test.ts` — structural: fixture 75 emits
  three IIFEs at v98/v99 and none at v84/v94/v96 (those versions do not inline);
  the flat prologue is gone; every guard in section 4 refuses on a synthetic
  statement list.
* `tests/gate/decompile/equivalence.test.ts` (T2) covers behaviour.

## 6. Measurement

`node tools/e2e/roundtrip-corpus.ts --only react-navigation-example-0.85.3 --passes on`,
same worktree, before -> after:

* IDENTICAL 6184 (42.83%) -> 6214 (43.04%) of 14437
* `diff:LoadFromEnvironment(imm)` 867 -> 804
* `diff:CreateFunctionEnvironment(imm)` 619 -> 616
* 31 functions newly IDENTICAL, 1 newly DIFFERENT (bucket
  `diff:LoadConst/GetGlobalObject`; recorded in the `docs/BUGS.md` row).

## 7. Interleaved ranges: measured, mostly not a reordering problem

`overlapping statement ranges` is by far the largest refusal (757
environments). `hermesc -O` schedules the statements of the IIFEs it inlined
freely, so environment A's stores can sit between two of environment B's and
neither is a contiguous run.

`src/emit/iife-group.ts` answers the reordering question. For each connected
group of overlapping environments it plans the stable partition of the region
into one block per environment (blocks in order of first appearance, the filler
between two of an environment's own statements staying with the preceding
block, which is what an accepted range already swallows). That permutation is a
sequence of swaps between statements of different blocks, and it is allowed
only when EVERY such pair provably commutes: both statements inert or a
`x = <identifier | literal | array/object literal of those>` store, and their
read/write footprints disjoint. A call, a member access (a getter is a side
effect, and a null base throws), a spread, a computed key, a control-flow
statement -- all refuse. A group that cannot be proved keeps its statement
order and refuses as before; a proved reordering that ends up buying no wrapper
is reverted, so the emitted statement list only ever moves when a wrapper
lands.

Measured with `node tools/passes/iife-overlap.ts <bundle.hbc>` on
react-navigation-example-0.85.3 (339 groups, 757 environments):

| class | groups | environments |
|---|---|---|
| `statement in two environments` | 291 | 622 |
| blocked swap, one side a member load or store | 18 | 63 |
| blocked swap, both sides identifier stores | 18 | 37 |
| blocked swap, one side an object literal | 4 | 19 |
| blocked swap, one side a labeled statement | 8 | 16 |
| reordering proved | 0 | 0 |

So the refusal is NOT mainly a statement-order artefact. 622 of the 757 (82%)
are groups in which a single statement names slots of two environments at once
(`_eA_0 = _eB_0;`, or a store of one environment's hoisted closure into
another's slot). No reordering can separate those, and section 4's
`environment read outside the range` guard would refuse them even if the ranges
were contiguous -- the wrapper would add a scope level to a chain the original
does not have. Strict nesting (an IIFE inside an IIFE) accounts for 204 of the
757 and is not a distinct fixable class either: it is nesting only of the
computed RANGES, and every such group is already in one of the rows above.

Of the remaining 135, every group has at least one swap this analysis cannot
prove, and the ones that look closest (`assign:ident=ident` on both sides) are
groups where a LATER pair blocks -- the table reports the first blocker only.
The commonest real blocker is the property store an inlined IIFE ends with
(`out.f = <closure>`, `arr[0] = <closure>`): proving that safe needs escape
analysis showing the base is a freshly allocated object with no setter. That
argument is section 9, and section 9.6 re-measures this table with it.

rnav is therefore UNCHANGED by this step (0 groups planned, so the emitted
statement list is the input one, byte for byte); the round-trip figures of
section 6 stand. What landed is the analysis, its measurement tool, and the
regrouping itself, which fires wherever an interleaving IS provable -- pinned
by the synthetic cases in `tests/gate/emit/iife-reconstruct.test.ts`.

## 8. Fixture 79 and the tests section 7 added

`tests/fixtures/constructs/79-interleaved-envs` is the interleaved shape at
v98/v99: two (and three) inlined IIFEs that hand their reader closures back
through an array, so the emitted statements are
`_e0_0 = a1; _e1_0 = a2; arr = new Array(2); arr[0] = x; arr[1] = y;` and both
environments' ranges cross. v84/v94/v96 do not inline them, so no sibling
environment exists there. The fixture pins the REFUSAL (the flat prologue
survives, which is never a behaviour change), and would go green on its own the
day the property-store argument above is made.

`tests/gate/emit/iife-reconstruct.test.ts` adds: a provable interleaving that
IS regrouped and wrapped; the same list with one property store, which refuses
with the blocking swap in the refusal's `detail`; a statement naming two
environments, which refuses with `statement in two environments` (rnav's
dominant class); and fixture 79's structural refusal at v98/v99.

## 9. Escape analysis: moving a store into a freshly allocated object

Section 7 measured the blockers and named the dominant one: the property store
an inlined IIFE ends with (`out.f = <closure>`, `arr[0] = <closure>`). A member
store is refused by section 7's `pureFootprint` because a setter is user code
and a null base throws, so it can never be reordered blind. This section is the
argument that lets a *specific* member store move: one whose base is an object
this function allocated and has not let out of its hands.

### 9.1 What is proved

For a region `[lo, hi]` of one overlapping group (`src/emit/iife-escape.ts`), a
name `n` is FRESH over `(a, hi]` when all of the following hold, where `a` is a
top-level statement index in `[lo, hi]`:

* **F1 allocation.** Statement `a` is `n = <alloc>` or `let n = <alloc>`, where
  `<alloc>` is an array literal, an object literal with no computed key and no
  spread, or the emitter's rendering of the `NewArray`/`NewFastArray` opcode
  (`new Array(<literal>)` carrying `fromNewArray`, `src/emit/lower.ts`) --
  never a call, a `new` of a name, or anything read from elsewhere. Every
  sub-expression of `<alloc>` is itself pure by section 7's rule.
* **F2 single definition in the region.** `a` is the last assignment to `n` in
  `[lo, hi]`; no other statement in `(a, hi]` writes the *name* `n`.
* **F3 no escape inside the region.** Every occurrence of `n` in `(a, hi]` is
  the BASE of a member access (`n.p`, `n[k]`), load or store. Not an argument,
  not a callee, not a value assigned anywhere, not returned, not thrown, not an
  element of a literal.
* **F4 no capture.** `n` does not occur anywhere inside a nested `func` of this
  scope, so no closure -- however it is later called -- can reach it.
* **F5 nothing before.** Occurrences of `n` at top-level indices `< a` are
  unconstrained (they concern the previous value in a reused register), but a
  member access on `n` before `a` is not covered by this proof and keeps the
  old, refusing footprint.

Occurrences at top-level indices `> hi` are deliberately UNCONSTRAINED: the
array an inlined IIFE fills is returned or passed on straight after the region
(`return arr`), and once the region has run, the reordering has preserved every
write and every written value, so a later escape observes exactly the same
object. Only an escape that can be triggered *while the region runs* could see
the difference, and F3/F4 exclude those.

### 9.2 The footprint of a member access on a fresh base

Given F1-F5, `n[k]` runs no user code and cannot throw on the base, so a member
statement gets a footprint like any other:

* `n[<lit>] = <pure>`: writes `n#<lit>`, reads `n` and the value's names.
* `x = n[<lit>]`: writes `x`, reads `n` and `n#<lit>`.

Distinct literal keys give distinct pseudo-names, so `arr[0] = x` and
`arr[1] = y` commute with each other, and the allocation `n = <alloc>` (which
writes the plain name `n`) never commutes with either -- a member access reads
`n`, so section 7's disjointness test already pins the allocation before its
stores. A non-literal key refuses (`E_KEY_NOT_LITERAL`): proving two register
keys distinct is a separate argument.

### 9.3 Filler repair

A statement in the region that names no environment (`r0 = a2`, the allocation
itself) is a FILLER; section 7 attached every filler to the preceding block.
That single choice is often the only thing that blocks a group: fixture 79
needs `arr = new Array(2)` and `arr[0] = x` to stay on the same side of the
partition, and the preceding block puts them on opposite sides. The planner now
repairs: when the first blocking swap is between a filler and anything else, it
moves the filler to the other block and re-verifies, at most `2 * region`
times. The repair is a heuristic; SOUNDNESS is unchanged, because the final
labelling is verified pair by pair exactly as before, and a labelling that
still blocks refuses (`regrouping did not converge` when the budget runs out).

### 9.4 Refusal codes

Reported per name by `src/emit/iife-escape.ts` and tallied by
`tools/passes/iife-overlap.ts`:

| code | meaning |
|---|---|
| `E_NOT_FRESH` | no allocation of the shape F1 defines the base in the region |
| `E_REASSIGNED` | the name is written again after the allocation (F2) |
| `E_ESCAPES_CALL` | the name is an argument, a callee or a `new` operand after the allocation (F3) |
| `E_ESCAPES_STORE` | the name is assigned, returned, thrown or put in a literal after the allocation (F3) |
| `E_ESCAPES_CLOSURE` | the name occurs inside a nested function of this scope (F4) |
| `E_KEY_NOT_LITERAL` | the property key is not a literal (9.2) |
| `E_VALUE_NOT_PURE` | the stored value is not an identifier/literal/pure aggregate |

### 9.5 The one premise that is not proved (A-PROTO)

`n[k] = v` on a fresh array or object literal still consults the prototype
chain for an accessor named `k`. This proof assumes the intrinsic
`Array.prototype` / `Object.prototype` carry no accessor property for the
literal key being stored -- i.e. that a bundle has not installed a setter for
`"0"` or for the property name an inlined IIFE writes. An object literal built
by `Object.create(null)`-style lowering has no chain at all and needs no
premise. A-PROTO is the single non-provable step in section 9; it is recorded
in `docs/BUGS.md` so it is never lost, and it is the same class of assumption
`hermesc -O` itself made when it scheduled these statements into each other in
the first place. Every other premise (F1-F5, 9.2) is checked syntactically and
conservatively: any use of a base that the analysis cannot classify is an
escape.

### 9.6 Measured (react-navigation-example-0.85.3)

`node tools/passes/iife-overlap.ts <bundle.hbc>`, before -> after section 9,
same 339 groups / 757 environments:

| class | groups before | envs before | groups after | envs after |
|---|---|---|---|---|
| `statement in two environments` | 291 | 622 | 291 | 622 |
| blocked swap, one side a member load or store | 18 | 63 | 16 | 64 |
| blocked swap, both sides identifier stores | 18 | 37 | 24 | 55 |
| blocked swap, one side an object literal | 4 | 19 | 0 | 0 |
| blocked swap, one side a labeled statement | 8 | 16 | 8 | 16 |
| reordering proved | 0 | 0 | 0 | 0 |

So the escape argument closes the object-literal class outright and the filler
repair carries several groups past their first blocker into a later one, but
**no group on rnav becomes provable**: the 64 environments still blocked on a
member store are blocked because their BASE is not fresh, not because the store
could not move. Bases refused, by section 9.4 code: `E_NOT_FRESH` 239,
`E_ESCAPES_CLOSURE` 88, `E_ESCAPES_STORE` 10, `E_ESCAPES_CALL` 2. The shape a
large bundle uses is a store into an object it was GIVEN (a module `exports`, a
`this`, a required namespace), not one it just allocated; fixture 79's
`arr = new Array(2)` is the allocating variant and is now wrapped.

rnav is therefore still UNCHANGED by the grouping step (0 groups planned, so
the emitted statement list is the input one). Re-measured on this machine with
`node tools/e2e/roundtrip-corpus.ts --only react-navigation-example-0.85.3
--passes on`, at `a217e9c` and with section 9 landed: IDENTICAL 6215 (43.05%)
of 14437 both times, `diff:LoadFromEnvironment(imm)` 804 both times,
`diff:CreateFunctionEnvironment(imm)` 621 both times -- byte for byte the same
corpus verdicts. (Section 6's 6214/616 predate a corpus migration; the
drift is the corpus-migration effect the `docs/BUGS.md` row already records,
which is why the before number was re-measured here rather than quoted.)

The next lead is NOT more reordering either: it is `E_ESCAPES_CLOSURE` and
`E_NOT_FRESH`, i.e. an argument about an object the function received rather
than allocated, which needs a whole-module notion of who else can see it.

## 10. The function's own environment is not a candidate

**Problem.** A function that inlined a callee AND captures its own locals owns
two kinds of environment: its OWN (`CreateFunctionEnvironment` at offset 0,
where hermesc always emits a function's own scope) and the callee's (created
later, at the call). Sections 2-4 treated both as candidates. The own
environment's statements run from the top of the body to the bottom, so its
range overlaps every inlined range and BOTH refused as `overlapping statement
ranges` (react-navigation-example module 0 / fn#2: own env 4 slots plus the
inlined namespace-interop helper's 2; `statement in two environments`, because
`w = n` stores the helper's slot into the caller's). That one shape -- every
module that does `import * as` -- was the bulk of
`diff:CreateFunctionEnvironment(imm)` (the factory) and
`diff:LoadFromEnvironment(imm)` (the helper's forEach callback, reading slot 0
of a merged environment at slot 4).

**Choice.** `ownEnvOf` (`src/emit/function.ts`) names the environment created
by a `CreateFunctionEnvironment` at offset 0 of this function. Passed as
`ownEnv`, it is skipped as a candidate (no refusal is recorded), its slots stay
in the flat prologue, and a range may name its slots (the `foreign` guard
exempts them): they are bindings of the enclosing function, which a wrapper
sees unchanged, and inside the inlined body hermesc addresses them through the
same register. A hoisted closure reading both the own environment and the
inlined one still refuses (`closure spans two environments`, fixture 121).

Offset 0 is not proof: a function with no own scope that STARTS with an inlined
callee also creates an environment at offset 0 (fixture 79's `pair`). Both
readings are checked by the same guards, so either is sound -- wrapping never
changes behaviour once the guards pass -- and the step runs both and keeps the
own-scope reading only when it wraps strictly more environments (ties keep the
section 2 result).

**Rejected.** Deciding own-vs-inlined from the env graph's parent links: every
`CreateFunctionEnvironment` in a function has the same parent (the closure's
captured environment), so the graph cannot tell them apart.

**Tests.** `tests/gate/emit/iife-own-env.test.ts` -- fixture
`120-own-env-plus-iife` (v98/v99 build `3,2`; the round trip reproduces the
sizes and every slot immediate; failed before this section with
`actual: [] expected: ['3,2']`) and its negative twin
`121-own-env-plus-iife-captures-outer` (no wrapper). Fixture 79's five
wrappers are unchanged.

**Measured** (`node tools/e2e/roundtrip-corpus.ts --only
react-navigation-example-0.85.3 --passes on`, clean worktrees, `926176b` ->
this section): IDENTICAL 6272 (43.44%) -> 6590 (45.65%) of 14437; 319
functions newly IDENTICAL (all from `diff:LoadFromEnvironment(imm)`), 1 newly
DIFFERENT (module 953 / fn#11791, `tree:unmatched-closure`: a wrapper hermesc
did not inline back). `diff:LoadFromEnvironment(imm)` 838 -> 208,
`diff:CreateFunctionEnvironment(imm)` 626 -> 341. Buckets that grew are
functions whose FIRST difference moved later, not regressions:
`diff:Call3(reg)` 11 -> 312 (the interop callback, now a register-allocation
difference from the `Reflect.apply` call shape), `diff:GetGlobalObject/
CreateFunctionEnvironment` 1 -> 200 (the factory, now differing at where the
inlined environment is created), `diff:GetById/NewObjectWithBuffer` 665 -> 702.

## 11. A closure belongs to the function that creates it

**Problem.** Bucket `tree:unmatched-closure(orig 1 vs recompiled 0)`
(react-navigation-example, 453 functions under 297 unmatched roots). The
emitter nests each function inside the OWNER of its closure environment
(`closureEnvOf`, `src/emit/index.ts` "Function nesting"). When the creating
function `C` owns no environment of its own (it captures nothing), the closure
environment is an ancestor `H`'s, so the function was emitted beside `C` in
`H`: module 91's `parse(text) { return text.split("\n").reduce(function (acc,
line) {...}, []) }` came out with the callback as a sibling declaration of
`parse`. The recompiled `parse` then creates no closure, `H` creates one too
many, and the closure is one instance per `H` call where the original makes
one per `C` call (a real identity divergence, not just a shape one). This
happens at v98/v99 only: at v84-v96 `C` reaches the closure environment
through its own scope, and the graph already put it at `C`.

**Choice.** After the joined/LCA moves, a function whose creation sites are
all in ONE function `C`, over one environment, with `C` strictly below its
home `H` (by the final `parentOf`), is re-parented to `C`. Sound because every
environment the body names is declared at `H` or above, all ancestors of `C`,
and `C` and the functions between declare only their own `_e<id>_<slot>`
names, so nothing is shadowed; the declaration is hoisted to the top of `C`,
so it is visible at every site. Running after the LCA rule means a creator
that was moved ABOVE `H` fails the `isAncestor(H, C)` check and keeps the
leftover-7 placement.

**Rejected.** Re-parenting whenever the sites lie in a subtree of `H` (to the
LCA of several creators): that is the "reparent inwards" variant the LCA rule
already measured worse, and a function created in two functions (hermesc
inlined its creator into both) has no single host.

**Tests.** `tests/gate/emit/closure-creator-host.test.ts`: fixture
`150-closure-created-in-inner-fn` (the round trip reproduces the closure tree
under `makeParser`; failed at v98/v99 before this section with
`actual: '(()()())' expected: '((())())'`) and its negative twin
`151-closure-created-in-two-fns` (the callback stays beside `left`/`right`).
T2 under the real Hermes VMs: both fixtures' decompiled output matches
`expected.txt` at v84, v94, v96, v98 and v99.

**Measured** (`node tools/e2e/roundtrip-corpus.ts --only
react-navigation-example-0.85.3 --passes on`, `1baaa7c` -> this section, same
machine): IDENTICAL 6590 (45.65%) -> 7107 (49.23%) of 14437; 520 newly
IDENTICAL, 3 newly DIFFERENT (module 821 / fn#14044, module 1537 / fn#13008,
fn#13010: `diff:LoadFromEnvironment(imm)`, the parent's environment slots
numbered in a different order). `tree:unmatched-closure(orig 1 vs recompiled
0)` 453 -> 63, all `tree:unmatched-closure(...)` buckets together 924 -> 185;
`diff:CreateFunctionEnvironment(imm)` 341 -> 183. Split diagnostics 4298 ->
4278. Buckets that grew (`diff:GetParentEnvironment/LoadConst` 68 -> 114,
`diff:GetParentEnvironment/GetGlobalObject` 227 -> 267,
`diff:CreateGenerator/GetGlobalObject` 4 -> 32, `diff:GetById/
NewObjectWithBuffer` 702 -> 740, and a few +25s) are functions that are now
paired with their recompiled twin and differ later, not regressions.

## 12. A closure created more than once per activation is an expression

**Problem.** review-1109-1 (fixture `200-closure-in-loop-identity`, every
version v84-v99, both `--passes` modes). Every nested function was emitted as
a declaration hoisted to the top of its host, and each `CreateClosure` site
read that one binding. A declaration makes ONE function object per activation
of the host; a `CreateClosure` makes a new one every time it executes. In
`for (...) fs.push(function () { return hv; })` the VM prints
`fs[0] !== fs[1]` true, the decompiled source printed false. Section 11
restored per-call identity (the right host); this restores per-execution
identity inside the host.

**Choice.** A function `g` is emitted as a function expression at each of its
creation sites (the `inlineFunctions` route the loop-local environments of
section 6 already use: `r7 = function _fn3() {...}`) when all of the
following hold: every creation site of `g` in the module is in its host `h`
(by the final `parentOf`); every site is a `CreateClosure` /
`CreateGeneratorClosure` / `CreateAsyncClosure` (a pre-v97 `CreateGenerator`
reads the inner function by name and keeps the declaration); `g` has no
creation-context copies (section "closure copies" owns those); and some site
CAN EXECUTE TWICE in one activation: it lies on a cycle of `h`'s normal CFG,
or one site reaches another (same block, later offset, or a CFG path). The
function expression keeps its own `this`, `arguments` and `new.target`, so it
is the same closure kind as the declaration; it is never an arrow. The name
stays `_fn<n>`, so a named expression still binds itself inside its body.

**Soundness of the hoisted form that remains.** If no site can execute twice,
each activation of `h` creates at most one object for `g`, and the declaration
creates exactly one. The two differ only in WHEN the object exists (activation
entry vs the site) and in a site that never runs. Neither is observable:
creating a closure runs no user code, and the synthetic name `_fn<n>` is read
only at `g`'s creation sites (each lowered to `rX = _fn<n>`), so no code
before a site can reach the object, and an unreached site exposes nothing. A
function whose sites lie in another function than its host (orphans, several
creators) is outside this rule and keeps the declaration; for several
creators the function is shared across them, which section 11's rejected
alternative already records.

**Rejected.** Inlining every nested function at its site. That is sound too
but turns every function-top declaration into a statement-position expression
(a readability loss for the common once-per-activation case) and duplicates
the body when hermesc duplicated a site on exclusive paths (a `finally` copied
into the normal and the exceptional exit), where at most one runs.

**Tests.** `tests/gate/emit/review-1109.test.ts` review-1109-1 cases (fixture
200 at v84, v94, v96, v98, v99 x `--passes none|on`; failed before with
`distinct: false`). T2 under the real Hermes VMs
(`tests/gate/decompile/equivalence.test.ts`) passes for fixture 200.
