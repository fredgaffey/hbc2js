# Review 2026-11-09 -- passes soundness (branch review-passes-1109)

Base: `origin/integrate-1109m` merged with `origin/passes-private-methods`
(only docs/BUGS.md and docs/test-count-baseline.json conflicted). Probes:
small construct sources compiled with tools/hermesc v84-v99, the original run
under the real Hermes VM, the decompiled output (`--passes on` and `none`) run
under node's vm, outputs compared.

## Verdicts per rule

| Rule | Verdict |
| --- | --- |
| call-shape R3e (spec 04 section 9) | sound in every probe (conditional/logical args, receiver reuse, loops, args that write the receiver register) |
| R3e narrowing `rN = _eX_Y; O[rN]` | sound but incomplete: it only looks at adjacent top-level entries of the argument sequence. A private read inside a conditional argument (`o.m(c ? this.#x : 0)`) is folded by R3e into the sequence as `c && (r4 = _e0_1, r1 = this[r4])`, and private-fields then leaves `#x` symbol-keyed. Output stays correct (the name is refused), so this is readability, not soundness |
| call-shape R3f `(0, O.p)(...)` and R3e/R3f order | sound |
| iife-reconstruct own-env (spec 27 section 10) | sound in probes |
| closure creator placement (spec 27 section 11) | the re-parent itself is sound, but see review-1109-1: a closure created in a LOOP of its creator is still one function object per creator call |
| inline-new derived prefix (spec 24 section 9.2 (6)) | sound by reading (getPrototypeOf on a class token runs no user code; counts match the header) |
| private-fields loops + R-PF1 mentions before creation | sound by reading; probes correct |
| private methods (spec 24 section 1.7.1) | sound in every probe where the fold fires (dominance over if / switch / labelled break / receiver reassignment / args that reassign the receiver) |

## Confirmed bugs (failing tests, not fixed)

Test file: `tests/gate/emit/review-1109.test.ts`.

* **review-1109-1** -- fixture `200-closure-in-loop-identity`. A closure created
  inside a loop is emitted as one hoisted function declaration in its creator,
  so each iteration gets the same object: VM `distinct: true`, decompiled
  `distinct: false`, at v84/v94/v96/v98/v99 in both `--passes` modes.
  Emitter-wide (pre-existing); section 11 claims to restore per-call identity
  and does, but per-iteration identity is still lost.
* **review-1109-2** -- fixture `201-private-brand-in-primitive`. `#x in 3`
  throws TypeError in the VM; the lowered `Object.prototype.hasOwnProperty.call(v,
  sym)` boxes the primitive and returns false. v98/v99, both modes. When the
  private-methods fold fires it emits a native `#m in x` and is correct; the bug
  is in the unfolded (refused) lowering.

## Unconfirmed concerns

* `isProvenUndefinedThis` (call-shape) counts only statement-level `rX = v`
  stores. After an R3e rewrite has moved writes into a call's argument
  sequence, a register written there and once elsewhere as `rX = undefined`
  would read as "proven undefined" and R3a/R3f would drop or change `this`.
  Probed (receiver reuse after R3e, loops); no hermesc output reached it.
* R3e drops the `F = R.P` store when the call statement overwrites F. If the
  argument evaluation or the call throws inside a `try` whose handler reads F,
  F no longer holds `R.P`. hermesc's register allocator keeps such a register
  live, so no source shape reached it.
* R3e moves a top-level `let x = v` between read and call to `let x;` before
  the read: a TDZ read of x in between (impossible for a register) would no
  longer throw.
