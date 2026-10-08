// Global-read lowering (docs/BUGS.md 2026-09-21, "src/emit global-access").
// Hermes has one opcode for a guarded global read -- `TryGetById`, "read
// the global, throw a ReferenceError if it's absent" -- and the decompiler
// reproduces it faithfully as `r1 = globalThis; if (!("p" in r1)) throw new
// ReferenceError(...); r0 = r1.p;`. Where nothing else in the function could
// make a bare `p` mean something other than that same global at the read
// site, `src/passes/global-access` (spec `docs/specs/passes/03-global-access.md`)
// folds the guard+read back down to a bare `p` reference, which recompiles
// to the same `TryGetById` Hermes started with -- smaller AND a closer
// reproduction of the original instruction than the guard scaffolding.
// Where it is NOT proven safe, the guard stays, because a wrong bare fold
// silently changes which binding a read observes -- see this fixture's
// second half.

// A -- POSITIVE: a clean, straight-line global read with nothing else in
// this function's own scope that could collide with the name `Error`.
// Folds to a bare `Error.name` (verified directly: recompiling the
// decompiled output with hermesc reproduces the exact same
// `GetGlobalObject` + `TryGetById "Error"` + `GetByIdShort "name"`
// sequence the original source compiled to).
function unshadowed() {
  return Error.name;
}

// B -- NEGATIVE: two DIFFERENT guarded global reads (`Reflect`, `String`)
// inside a `do...while` loop, alongside enough other live registers that
// Hermes's own allocator (measured directly, all five hermesc versions --
// v84/94/96/98/99) produces a shape the pass ladder's own rewrite-
// application safety net refuses to touch: applying the fold here would
// leave a register read before its first definition elsewhere in the
// rewritten statement list (`runPasses`' own post-rewrite soundness check,
// shared by every stage-B pass -- not specific to global-access's own
// `classifySite` refuse reasons, but the exact same kind of guard this
// fixture exists to prove: a fold that cannot be shown safe here is
// abandoned, and the guard -- correct, just unfolded -- survives). Both
// `Reflect` and `String` stay guarded through every hermesc version tested.
function loopy(n) {
  var out = "";
  var i = 0;
  while (i < n) {
    out = out + Reflect.apply(String, null, [i]);
    var scratch = { x: i, y: out.length, z: n };
    out = out + scratch.x;
    i = i + 1;
  }
  return out;
}

print(unshadowed());
print(loopy(3));
