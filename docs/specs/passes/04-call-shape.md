# 04 — `call-shape` (stage B, catalogue row **R3**)

Reading list: `src/passes/README.md`, this file.
Depends on `01-framework-fixes.md`; runs after `expr-rebuild` and
`global-access`.

## 1. Purpose

`src/emit/lower.ts` §7.4 routes every call that misses the `GetById`+`CallN`
fast path through `Reflect.apply(callee, thisArg, [args])`, and every `Construct`
through `Reflect.construct`. That is correct (EM-04: never `.bind`, and V8's
TypeError text follows the call shape) but unreadable. This rung restores the
call shapes whose semantics are provably identical.

Before — `19-var-hoisting/v94.hbc` `fn#1`, after `expr-rebuild` +
`global-access`:

```js
Reflect.apply(print, undefined, ["x before declaration:", undefined]);
```

After:

```js
print("x before declaration:", undefined);
```

## 2. Baseline shapes

| Emitted by | Shape |
|---|---|
| `applyCall` (`lower.ts`) | `Reflect.apply(F, T, [a…])` — `T` is `frameArgs[0]`, `undefined` for a plain call |
| `Construct` | `Reflect.construct(C, [a…])` and `Reflect.construct(C, [a…], NT)` |
| `newSites` fast path | already `new C(a…)` — nothing to do |
| `CallBuiltin functionPrototypeCall` | `__hbc_b_functionPrototypeCall(F, T, a…)` |
| `CallBuiltin functionPrototypeApply` | `__hbc_b_functionPrototypeApply(F, T, arr)` |

`Reflect.get` / `Reflect.set` (the `WithReceiver` opcodes) encode a distinct
receiver and are **never** rewritten.

## 3. AST shape the rung owns

May match/rewrite: a `call` expression whose callee is
`member(ident "Reflect", lit "apply"|"construct", computed:false)` or
`ident "__hbc_b_functionPrototypeCall"|"__hbc_b_functionPrototypeApply"`
(matched by name through `isHelperCall`, never by argument position).
**Must not touch:** any other call; a callee expression with side effects
(refuse); the argument array when it is not a literal `k:"array"`.

## 4. Matcher

Site = one statement list `L`; walk its expressions in pre-order and capture the
**first** rewritable call. Common preconditions for every rule:

* the last argument that should be the argument list is literally
  `{k:"array", elements: […]}` — a spread already materialised into an
  identifier means the arity is unknown at print time: refuse (`dynamic-args`);
* no element of that array is itself a `k:"seq"` expression;
* the callee expression `F` is `ident`, or a `member` chain over `ident`/`lit`
  (a `member` read is an effect, but it is the *first* effect in both the old
  and the new form, so the order is preserved). Anything containing a `call`,
  `new`, `assign` or `unary delete` → refuse (`impure-callee`).

**R3a — plain call.** `Reflect.apply(F, T, [a…])` where `T` is the literal
`undefined` (`{k:"lit", text:"undefined"}`) → `F(a…)`.
`T` as an *identifier* is accepted only when it is a register with exactly one
write in `ctx.fnBody` whose value is the literal `undefined` and
`nested === 0`; otherwise refuse (`unproven-this`). Additionally refuse when
`F` is a `member` (that would silently change the receiver from `undefined` to
the member's object): a `member` callee only goes through R3b.

**R3b — method call.** `Reflect.apply(member(O, P, c), R, [a…])` where `O` and
`R` are *the same identifier node* (`ident` name equality; `O` must be an
`ident`, not a nested member) → `O.P(a…)` / `O[P](a…)` per `c`. Requiring an
identifier is what makes evaluating `O` twice free.

**R3c — construct.** `Reflect.construct(C, [a…])` → `new C(a…)`. With a third
argument `NT`, rewrite only when `NT` is syntactically identical to `C`
(`new.target === C`, i.e. an ordinary `new`); otherwise refuse
(`explicit-new-target`). In that 3-argument form the baseline evaluates `C`
*twice* (once as the target, once as the new-target) while `new C(a…)`
evaluates it *once*, so the fold is additionally sound only when `C` is an
`ident` (a register/identifier is free to re-evaluate); a member `C`
(`a.b`) could carry a getter/Proxy that would fire once instead of twice —
refuse (`duplicated-construct-callee`). This case is not reachable from the
current emitter but the guard is load-bearing
against future emitter changes.

**R3d — `Function.prototype` helpers.**
`__hbc_b_functionPrototypeCall(F, T, a…)` → `F.call(T, a…)`;
`__hbc_b_functionPrototypeApply(F, T, arr)` → `F.apply(T, arr)`. Here `arr` may
be any expression — `.apply` takes it as a value, so no array literal is needed.
`F` must satisfy the `impure-callee` rule above. Fewer than two arguments →
refuse (`helper-arity`).

**R3f — receiverless member call** (added 2026-11-09, round-trip review
`passes-roundtrip-global`). `Reflect.apply(member(O, P, c), T, [a…])` where `T`
passes R3a's undefined proof → `(0, O.P)(a…)` (a `seq` callee). This is
Babel's interop call, `(0, _mod.default)(x)`, and it was the one shape R3a/R3b
left as a real `Reflect.apply`: the old `member-callee-with-undefined-this`
refusal was right that `O.P(a…)` would change `this`, but the sequence form
does not — a parenthesised comma expression yields a plain value, so the call
gets `this === undefined`, exactly as the bytecode did. Effect order is
unchanged (`O.P` read, then the arguments, then the call); a non-callable
`O.P` still throws `TypeError`, with hermesc's call-site message instead of
`Reflect.apply`'s, the same caveat R3a already carries. `hermesc -O` compiles
`(0, O.P)(a…)` to `GetById` + `LoadConst undefined` + `CallN`, the original
instruction sequence; on react-navigation-example (v98) the leftover
`Reflect.apply` was the largest sub-cause of the `diff:*/GetGlobalObject`
buckets. Fixture `160-receiverless-member-call` (with the plain method call
`ns.fn(x)` as its negative twin), test
`tests/gate/passes/call-shape-receiverless.test.ts`. The checker additionally
asserts the callee is exactly `(0, F)` over the source's own `F` node.

## 5. Writer

Replace exactly that one `call` node in place; the enclosing statement and every
other expression is untouched. `src/emit/print.ts` owns precedence and
parentheses — never add them. `new C()` with zero arguments prints as `new C()`,
never `new C`.

## 6. Checker

Class: **expression-only** (ladder §4.3). `effectSequence` records a `call`/`new`
as *(callee shape, arg count)*, so R3a…R3d preserve it by construction; `check`
asserts that plus what `rewrite` assumed:

1. `expressionOnlyCheck(before, after)` — the effect sequences must be
   deep-equal, in particular the member read of `O.P` in R3b appears in both;
2. the rewritten node's argument count equals the source array's length;
3. the callee is still `impure`-free (recompute, do not trust match data);
4. R3a: `T` is the literal `undefined`, or its register still has exactly one
   `undefined` write in `before` and `nested === 0`;
5. R3b: `O` and `R` are the same identifier name in `before`;
6. R3c: no third argument, or the third is syntactically identical to `C` and
   `C` is an `ident` (recomputed via `classifyNode`, same as `match`);
7. `parses` is run once per function by the driver (`01` F1).

## 7. Ordering, refusals, semantics, metrics

**Ordering.** `after: ["expr-rebuild", "global-access"]`, and
`before: ["spread-rest", "optional-chain", "class-recover"]` (batches 3–4):
spread call arguments and optional calls are shapes *of a call*, not of
`Reflect.apply`.

**Refuse (per-site):** `dynamic-args`, `impure-callee`, `unproven-this`,
`member-callee-with-undefined-this` (retired 2026-11-09: R3f now rewrites the
site; the reason name stays in the type for history), `explicit-new-target`,
`duplicated-construct-callee`, `helper-arity`, `reflect-get-set` (never
matched at all).

**D14 / semantics.**
* `Reflect.apply` throws `TypeError: Function.prototype.apply was called on
  undefined` when `F` is not callable; `F(a)` throws `TypeError: F is not a
  function`. The recovered shape is the one the *original source* produced, so
  this moves the output **towards** the ground truth, not away — but it is a
  message change, so any fixture whose verdict moves is a hard stop (PL-09).
* R3b changes nothing about the receiver: `O` is an identifier, evaluated twice
  in the old form and once in the new, with no observable difference.
* `Reflect.construct(C, args, NT)` with `NT !== C` is genuinely not `new C(…)`
  (it changes `new.target` and the prototype the object is created from) —
  hence R3c's refusal.

**Fixtures (red→green).** `targets: ["19-var-hoisting", "01-if-else-chain",
"32-class-basic", "21-iife-closures"]`, all five versions plus `.min`/`.obf`.
Unit tests: ≥1 positive per rule; negatives for a non-literal argument array,
an impure callee (`Reflect.apply(f(), undefined, [])`), a `member` callee with
`undefined` receiver, and `Reflect.construct` with a distinct new-target; ≥1
site `check` refuses.

**Corpus metric.** Share of emitted functions containing zero `Reflect.apply` /
`Reflect.construct`: baseline **0 %**, target **≥ 95 %** over
`tests/fixtures/constructs/**` at all five versions, and ≥ 90 % on the RN
template bundle. Remaining sites must all carry a recorded abandonment reason —
the histogram in the project status is the deliverable, not just the percentage.

**Estimated size:** ~150 lines across `match/rewrite/check`, ~200 lines of
tests.

## 9. R3e -- the method read separated from its call by the arguments

**Problem.** hermesc evaluates `o.m(args)` as GetById (the method), then the
arguments, then `CallN` with `this = o`. When an argument holds control flow
(`o.get ? o : {...}`, `c ? 1 : 2`), the structurer cannot keep the read and the
call in one expression: the output is
`L0: { r4 = a1; r3 = r4.m; ...; if (C) break L0; ...; break L0; }` followed by
`Reflect.apply(r3, r4, [A...])`. R3a refuses it (`unproven-this`) and R3b only
matches an inline member callee. The recompile then pays for `Reflect`,
`apply` and a `NewArray`, which shifts every register after it: on
react-navigation-example-0.85.3 this is the namespace-interop helper's forEach
callback (`Object.defineProperty(t, n, o.get ? o : {...})`), the bulk of
`diff:Call3(reg)` (11 -> 312 once spec 27 section 10 let the callback through).

**Choice.** `matchCondArg` (`match.ts`), tried only when no R3a-R3d site
exists in the list. For a statement whose FIRST evaluation is
`Reflect.apply(F, R, [A1..An])` (the statement value, an assignment's value, or
the object of a member read), n >= 1, F and R distinct registers: scan back to
the statement writing F. It must be `F = R.P` (P a simple member chain), at
top level or at the top level of a labelled block. Everything between the read
and the call becomes expressions, in order: an expression statement as itself;
`if (C) break L; T` as `C || (T)`, `if (!C) break L; T` as `C && (T)`;
`if (C) { T; break L; } E` as `C ? (T) : (E)`; a trailing `break L` ends the
block; a nested labelled block flattens the same way; a top-level `let x = v`
becomes `x = v` with `let x;` declared in front. The result is
`R.P((<those expressions>, A1), A2, ..., An)`; a block prefix before the read is
hoisted out of the block. Sound because the order is unchanged (read R and P,
then the argument effects, then A1..An, then the call) given the guards: no
write to R between read and call (the call's `this` is the value P was read
from; R is a frame-local register), F neither read nor written between, F read
exactly once in the call statement and either used nowhere else or overwritten
by that statement (the fold deletes the `F = R.P` store), no break to the block
from the hoisted prefix, and no block-scoped declaration in it. `check`
recomputes the splice from `before` and requires `after` to equal it.

**Rejected.** Folding only the callee (`R.P(A...)` with the statements left in
place): it moves the GetById after the argument effects -- `o.get` is a getter
call that could replace `o.m` -- and recompiles differently anyway. Recovering
a general ternary first and then reusing R3b: the conditional is not always a
single assignment (the interop callback builds an object and a closure in one
arm), and the comma form is exactly what hermesc lowers identically.

**Tests.** `tests/gate/emit/call-cond-arg.test.ts` -- fixture `130-call-cond-arg`
(at v94-v99 `pick`, `twoConds`, `reassign`, `viaGlobal` recompile to the
original normalised bytecode with object-literal property stores masked; at
every version no `Reflect.apply` keeps a callee read off its own `this`; failed
before this section with six such sites per version) and its negative twin
`131-call-cond-arg-other-this` (explicit `f.call(other, ...)`, a reused method
value: never rewritten onto the object the method was read from). Both
EQUIVALENT under the real VMs v84/v94/v96/v98/v99. Unit tests in
`tests/gate/passes/call-shape.test.ts` (receiver write, live callee, forged
after). v84 is left out of the identity check only: its decompiled `let`s
recompile with TDZ `ThrowIfEmpty` checks the original lacks (pre-existing).

**Measured** (`node tools/e2e/roundtrip-corpus.ts --only
react-navigation-example-0.85.3 --passes on`, `1baaa7c` -> this section):
IDENTICAL 6590 (45.65%) -> 6645 (46.03%) of 14437; 55 newly IDENTICAL, 0 newly
DIFFERENT. `diff:Call3(reg)` 312 -> 9, `diff:GetById(reg)` 388 -> 191. Buckets
that grew are first differences moving later, not regressions:
`diff:NewObjectWithBuffer/CreateClosure` 2 -> 307 (305 of them the interop
callback, now differing where hermesc places the hoisted `get` closure relative
to the object literal) and `diff:PutOwnBySlotIdx/PutByIdLoose` 2 -> 172 (170
from `diff:GetById(reg)`: an object literal with non-constant values now
recompiles its property stores as PutByIdLoose -- the object-literal bucket).

## 10. R3g -- the v98+ `Function.prototype.call` diamond (`fcall-diamond`)

**Problem.** From bytecode v98 (and at v99), hermesc lowers `F.call(T, a...)`
to a diamond: `C = GetById F, "call"; JmpBuiltinIs Lfast, <functionPrototypeCall>, C`,
then a generic arm `CallN+1 Y, C, F, T, a...; Jmp J` and a fast arm
`CallN X, F, T, a...` (each arm re-materialising its own constant arguments,
often in different registers; `F.call()` has the fast arm load `undefined` as
`this`; past three arguments the generic arm is a long-form `Call` through the
outgoing-argument registers). It printed as
`if (C === __hbc_b_functionPrototypeCall) {fast} generic`, which recompiles to
something else (~184 functions in the roundtrip `diff:TryGetById(reg)`
bucket).

**Choice.** A stage-A annotation rung, `fcall-diamond`, owns the diamond; it
sets `if.keepOnly` to the generic arm and the emitter prints that arm alone,
with no test. `call-shape` R3b then turns the generic `Reflect.apply(F.call,
F, [T, a...])` into `F.call(T, a...)`, which hermesc compiles back into the
same diamond. One owner each: the diamond's proof is `fcall-diamond`'s, the
call form stays `call-shape`'s.

**Soundness.** The fast arm only runs when `C` is the VM's builtin
`Function.prototype.call`; then the generic arm's `Call(C, F, [T, a...])` is
by ES2024 20.2.3.3 exactly `Call(F, T, [a...])` -- the fast arm (a
non-callable `F` throws a TypeError either way; only the message text can
differ). When `C` is anything else (a shadowed own `.call`, an overridden
`Function.prototype.call`) the generic arm ran before and still does. So
printing only the generic arm is sound once `match` proves, from the
bytecode and never from the printed tree:

1. the branch is `JmpBuiltinIs[Not]` on builtin `functionPrototypeCall` of the
   module's own builtin table; fast = the arm taken when the test holds;
2. both arms are private (one predecessor, not handler entries), exit to one
   common join `J`, and share the same exception handlers;
3. symbolically evaluating each arm (unwritten register = its shared entry
   value; only `LoadConst*`/`Mov` before the call, else refuse) gives a
   generic callee equal to the tested register's entry value, a generic
   `this` equal to the fast callee, and equal remaining arguments (a missing
   `thisArg` = `undefined`);
4. every register whose final value differs between the arms is dead at
   `J`, and every register whose pre-call value differs is dead at each
   handler (`registerLiveAfter`);
5. the fast block occurs exactly once in the tree, alone (plus jumps) in one
   arm of this `if`.

The tree keeps both arms (stage A must stay CFG-isomorphic for the driver's
round-trip), so `keepOnly` is a transparent annotation; `check` re-derives
1-5 and asserts nothing but the annotation changed.

**Rejected.** A stage-B rewrite of the printed `if (c === __hbc_b_...)` shape:
it would have to re-prove arm equivalence from printed JS, where the
register-renamed constant loads and the outgoing-register `Mov`s are already
gone, and every printer change would move its matcher. Deleting the fast arm
from the IR outright: the stage-A driver's P1 edge check rejects it.

**Known gaps.** `fcall-diamond` labels: the `break L` inside the hidden fast
arm still counts as a use, so `label-clean` keeps the wrapper (`L0: { ...;
break L0; }`, compiles identically). A long-form generic `Call` collapses but
`expr-rebuild` does not yet sink `C = F.call` past the outgoing `Mov`s, so it
prints as `Reflect.apply(C, F', [...])`. The `functionPrototypeApply`
(builtin 55) diamond has a `CallBuiltin` fast arm and is not matched.

**Tests.** `tests/gate/passes/fcall-diamond.test.ts`: fixture
`170-function-call-diamond` (two-argument, zero-argument, constant-argument,
five-argument, shadowed `.call`, overridden `Function.prototype.call`) is T2
PASS on the real VMs at 84/94/96/98/99 and has no shim left at 98/99;
hand-built arms pin the accepted shapes and the refusals (wrong callee, wrong
`this`, different argument/constant, arity, unmodelled instruction).
