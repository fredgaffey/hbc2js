// fix-closure-identity-2 (review-1110 iife/private): hermesc inlines `wrap`
// into both `a` and `b`; every call still creates a fresh closure, and the
// copies share the host's captured variables.
function H(t) {
  function wrap() { return function () { return t; }; }
  function a() { return wrap(); }
  function b() { return wrap(); }
  var setT = function (v) { t = v; };
  return { a: a, b: b, setT: setT };
}
var h = H(1);
var a1 = h.a(), a2 = h.a(), b1 = h.b();
print('distinct:', a1 !== a2, a1 !== b1, a2 !== b1);
h.setT(7);
print('shared:', a1(), a2(), b1());
var seen = new WeakMap();
[a1, a2, b1].forEach(function (f, i) { seen.set(f, i); });
print('weakmap:', seen.get(a1), seen.get(a2), seen.get(b1));
