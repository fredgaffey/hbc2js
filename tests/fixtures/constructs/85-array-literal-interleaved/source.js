// Measured directly building this fixture (all five hermesc versions): a
// genuinely SAFE interleaved statement is real but narrow. Hermes's register
// allocator reuses a scratch register the moment it is freed, and within one
// array literal's own element evaluation, a register becomes free by being
// READ as an earlier element's own value -- so a *second* arithmetic element
// needing its own scratch register (`b + 1`, `c + 1`, ...) almost always
// reuses a register an earlier element already read, which `canHoist`
// correctly refuses to hoist (see `nonHoistable` below; this is F1's
// dominant real shape, unchanged by this rung). The positive case that DOES
// commute in real bytecode is a *reference* copy that needs no computation
// at all -- e.g. an already-created nested closure's reference, moved into a
// fresh scratch register that nothing before it has touched (see
// `hoistable` below).

// A -- POSITIVE: `merge` is looked up and called first (unrelated register
// traffic); the nested closure `_fnN`'s reference is then copied into a
// fresh scratch register between the array's definition and its first
// element store. Nothing before that copy reads the scratch register it
// targets, and the value it copies (a bare closure reference) reads no
// register the run depends on -- `canHoist`'s proof holds, the copy
// commutes above the whole run, and the fold completes.
function lookupMerge(name, n) {
  return function (list) {
    return list.length + n;
  };
}
function hoistable(cb, extra) {
  const merge = lookupMerge("setState", 3);
  return merge([
    function (a, b) {
      return cb(a, b) + extra;
    },
    extra,
  ]);
}

// B -- NEGATIVE control: two arithmetic elements need their own scratch
// register in turn. The first (`a + 1`) is read once by its own store,
// freeing that register; the reload for the LAST element (`a3` here) reuses
// the exact same register -- a register `canHoist`'s own precondition 1
// (the candidate's target must be read nowhere earlier in the run) finds
// already read, so hoisting it would change what that earlier store
// observed. Refused, exactly like before this rung: `non-own-index-store`
// at the reload, `partial-run` at the definition.
function nonHoistable(a1, a2, a3) {
  const t = a1 + 1;
  return [a1, t, a2, a3];
}

print(JSON.stringify(hoistable(function (a, b) { return a + b; }, 5)));
print(JSON.stringify(nonHoistable(1, 2, 3)));
