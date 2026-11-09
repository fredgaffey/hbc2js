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
3. the read is not the whole stored value of `x = N` / `let x = N` with `x`
   a non-register target (member, env slot, named binding). That is how a
   source *declaration* surfaces (`r1.m = m`, `_e14_3 = _fn5`). Hermes
   already created that closure at entry, where the store sits, so moving it
   would change no bytecode and would cost the declaration form;
4. no nested block, `catch` parameter or loop binding of the host declares a
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
or enclosing-scope names, and condition 4 rules out shadowing. A register
copy (`rX = function get() {...}`) that is read twice later still holds the
one closure, so fixture 230's `twice` still prints `true`.

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
