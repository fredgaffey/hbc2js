// Review 1110 (diamonds): a loose, simple-parameter function forwarding its
// `arguments` (the v98+ `f.apply(t, arguments)` diamond's generic arm, and a
// plain escaping call at every version) hands the callee the real loose
// arguments object, whose own `callee` is the function itself. The
// decompiler's unmapped copy (`__hbc_arguments`) must keep that `callee`
// (a strict copy's `callee` is a throwing accessor), and a strict function's
// copy must keep the throwing one.
function describe(a, self) {
  var c;
  try { c = typeof a.callee + ":" + (a.callee === self); } catch (e) { c = "threw " + e.name; }
  var d = Object.getOwnPropertyDescriptor(a, "callee");
  return c + " desc=" + (d ? ("value" in d ? "data" : "accessor") + (d.enumerable ? "E" : "") + (d.configurable ? "C" : "") : "none") +
    " " + Object.prototype.toString.call(a) + " " + a.length + " keys=" + Object.keys(a).join(",");
}
var probe = function () {};
probe.apply = function (t, a) { return describe(a, t); };
function looseForward(f, t) {
  return f.apply(looseForward, arguments);
}
function strictForward(f, t) {
  "use strict";
  return f.apply(strictForward, arguments);
}
function looseEscape(x) {
  return describe(arguments, looseEscape);
}
function looseStore(x) {
  var a = arguments;
  a.extra = 1;
  return describe(a, looseStore);
}
function strictEscape(x) {
  "use strict";
  return describe(arguments, strictEscape);
}
print("looseForward " + looseForward(probe, 1, 2));
print("strictForward " + strictForward(probe, 1, 2));
print("looseEscape " + looseEscape(7));
print("looseStore " + looseStore(7, 8));
print("strictEscape " + strictEscape(7));
