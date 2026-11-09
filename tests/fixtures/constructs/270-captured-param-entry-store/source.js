// roundtrip-paramenv (round-trip bucket `diff:StoreToEnvironment/LoadParam`,
// the #1 DIFFERENT bucket on the second-app corpus run of 2026-11-09):
// a parameter captured by a closure lives in the function's environment from
// entry. hermesc stores it there right after its LoadParam, in parameter
// order, interleaved with the plain (uncaptured) parameters' loads. The
// decompiler printed the capture as `let _eN_M; ... _eN_M = a2;`, a separate
// variable assigned from the parameter, and the recompile scheduled that
// store after the next parameter's LoadParam.
function factory(g, req, imp, m, exp, map) {
  'use strict';
  exp.get = function () { return req(map[0]); };
  exp.first = function () { return map[1]; };
  exp.plain = g;
  exp.direct = req(map[1]);
}
var e = {};
factory(10, function (x) { return 'req:' + x; }, 0, 0, e, ['a', 'b']);
print(e.get(), e.first(), e.plain, e.direct);

function sloppy(a, b, c) {
  function inner() { return a + c; }
  return inner() + b + arguments.length + arguments[0];
}
print(sloppy(1, 2, 3));
