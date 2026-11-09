# 32 — `closure-inline` (stage B, catalogue row **R17**)

## 1. Problem

The emitter prints every closure that is not loop-local as a hoisted
`function _fnN` declaration at the top of its host, and the `CreateClosure`
site as a read of that name. A hoisted declaration creates its closure at
function entry. Hermes creates a function *expression*'s closure where the
expression is evaluated. So for the source
`Object.defineProperty(o, k, {get: function () {...}})`, the original reads
`Object` (`GetGlobalObject`/`TryGetById`) before `CreateClosure`, and the
recompiled decompile creates the closure first. On react-navigation-example
(v98, passes-on) this was the 214-function roundtrip bucket
`diff:GetGlobalObject/CreateClosure`.

## 2. Choice

The site is the whole function body. A top-level `func` statement `F` named
`N` moves to its read as a named function expression (the same node: name,
params, body, generator/async flags) when all of these hold:

1. outside `F`, `N` has exactly one read and no write, and no nested function
   mentions it (`identUses`); `F` does not mention itself;
2. no loop statement (`while`/`do-while`/`for`/`for-in`/`for-of`, test and
   body alike) contains the read, so the read runs at most once per
   activation;
3. the read is not the whole stored value of a plain store, `x = N` or
   `let x = N`, whatever `x` is. That is how a source declaration surfaces
   (`r1.m = m`, `_e14_3 = _fn5`). It is also how the emitter spells a bare
   `CreateClosure` into a register (`r3 = _fn1`), which later rungs and
   readers key on: class-recover's constructor binding and array-literal's
   reference copy. A store already sits where Hermes created the closure, so moving it would gain nothing;
4. the read is not a direct argument of a runtime helper
   (`__hbc_makeGenerator(_fn4)`, the async spawn driver). The PARENT's
   generator/async rungs (spec 25/29) run later, in the parent's pipeline,
   and read this body's hoisted factory declarations as their evidence;
5. the bytecode does not create the closure in the function's prologue,
   i.e. before the first instruction outside environment/parameter/constant
   set-up and other closure creations. Such a closure is a source declaration,
   or is used by the opening statement, so hoisting is already the faithful
   order. The function index comes from the body's `// fn#N` line and is
   matched against `CreateClosure` operands in `ctx.cfg`;
6. no nested block, `catch` parameter or loop binding of the host declares a
   name `F` mentions (no shadowing at the new position).

Registered after every structure rung that looks for hoisted declarations
(`class-recover`, `super-call`, `ctor-this`, `inline-new`, `private-fields`)
and after `fn-naming`, so the moved function keeps its recovered name. It runs
before `reg-split`/`var-naming`. `check` re-derives the site from `before`,
requires `after` to equal that one move exactly, requires it to parse, and
allows no new free name.

**Soundness.** Creating a closure has no observable effect except the new
object's identity. The global read, and every other effect, stays where it
was: only the creation moves, to the point where its single read already
was. Before the move the closure existed from entry, but nothing could
observe it before that read (condition 1). Under condition 2 the read runs
at most once per activation. A hoisted declaration also makes one closure per
activation, so the number of distinct closures and their identities are
unchanged. It captures the same bindings: env slots are function-top `let`s
or enclosing-scope names, and condition 6 rules out shadowing. A register
copy (`rX = function get() {...}`) that is read twice later still holds the
one closure, so fixture 230's `twice` still prints `true`.

**Analysis cost.** All of a body's declarations are decided in a constant
number of walks (`identUsesMany` over the body and over its outermost loops).
`rewrite` moves every accepted one at once. A first version walked once per
declaration and re-matched once per move, and it did not finish the
react-navigation split in 14 minutes; the whole run normally takes about
3.5 minutes.

After object-literal-arg (spec 20 section 9) was merged in, the split hung
again, for hours (closure-inline-hang). The cause was not this pass:
object-literal-arg's `stableFunctionNames` walked the whole body once per
top-level declaration, on every list it matched. A bundle's global function
holds every module factory as a declaration, and each factory nests its
module, so one match cost declarations times bundle size. It now makes one
`identUsesMany` walk per body object, memoised. `entryCreated` is memoised
per `FunctionCfg` too, since `match` and `check` both ask on every driver
iteration. `tests/gate/passes/closure-inline-hang.test.ts` counts node
visits and driver iterations, not wall time.

**Printer side fix.** A function expression in callee position
(`_fn3(a, b)` -> `(function _fn3() {...})(a, b)`) printed as
`function _fn3() {...}(a, b);`. That parses as a declaration followed by a
parenthesised expression, so the call silently never ran. It showed up as
DIVERGENT on the `.obf` fixtures 02/03/04 at v98/v99. `printStmt` now
parenthesises any expression statement whose text starts with `function` or
`{`. The regression test is in `closure-inline.test.ts`.

## 3. Rejected alternative

Emit-level placement: print every single-site closure as an expression at
its `CreateClosure`, as the loop-local env path already does
(`src/emit/index.ts` `inlineFunctions`). That would also fix the loop case
below, but it rewrites the text of every fixture that has a closure, with or
without passes (the golden policy for this item is additions only), and it
turns source declarations into expressions.

## 4. Known gap

The loop case is refused, not fixed. A non-loop-local closure created inside
a loop is still one hoisted declaration, so every iteration sees the SAME
closure where the original made a fresh one (`fs[0] === fs[1]` is `true`
after decompiling and `false` originally). This was found while building
fixture 230 and is recorded in `docs/BUGS.md` (2026-11-09, closure identity
in loops).

Fixture `230-closure-inline-getter` (two getters, a shared getter, a
hoisting use, an absent global) is T2 PASS at 84/94/96/98/99. Tests are in
`tests/gate/passes/closure-inline.test.ts`.
