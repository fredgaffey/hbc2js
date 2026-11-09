// docs/BUGS.md 2026-11-09 "method read moved past an intervening getter"
// (found by review "passes-roundtrip-objlit"). Hermes reads `api.m` BEFORE it
// evaluates the descriptor literal's `src.v` (source order), but the emitter's
// method-call fusion (src/emit/lower.ts, spec 07 section 7.4) re-emits the read
// at the call, after the literal's statements, so the decompiled program logs
// "v,m" where the original logs "m,v".
var log = [];
var api = {
  get m() {
    log.push("m");
    return function (t, k, d) { t[k] = d.value; };
  },
};
var src = {
  get v() { log.push("v"); return 1; },
};
function inSourceOrder(t) {
  api.m(t, "c", { enumerable: true, value: src.v });
}
var target = {};
inSourceOrder(target);
print(log.join(","), target.c);
