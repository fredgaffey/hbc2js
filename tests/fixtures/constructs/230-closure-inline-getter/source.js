// 230: a getter closure created inside the descriptor literal of an
// `Object.defineProperty` call (roundtrip `diff:GetGlobalObject/CreateClosure`
// bucket). Hermes reads `Object` BEFORE it creates the closure; a hoisted
// `function _fnN` declaration recompiles with the closure created at entry.
function reexport(exports, mod) {
  Object.defineProperty(exports, "foo", { enumerable: true, get: function () { return mod.foo; } });
  Object.defineProperty(exports, "bar", { enumerable: true, get: function () { return mod.bar; } });
  return exports;
}
// negative twin 1: one closure, two uses -- both getters must stay the SAME function.
function twice(o) {
  var g = function () { return 7; };
  Object.defineProperty(o, "a", { get: g });
  Object.defineProperty(o, "b", { get: g });
  return Object.getOwnPropertyDescriptor(o, "a").get === Object.getOwnPropertyDescriptor(o, "b").get;
}
// negative twin 2: a declaration used before its statement (hoisting).
function early(o) {
  var v = h();
  function h() { return o.k; }
  return v;
}
// an absent global read after the closure would be created: still a ReferenceError.
function absent(o) {
  Object.defineProperty(o, "z", { get: function () { return 1; } });
  return noSuchGlobal230.x;
}
var src = { foo: 1, bar: 2 };
var ex = reexport({}, src);
src.foo = 3;
print(ex.foo, ex.bar, Object.keys(ex).join(","));
print(twice({}), early({ k: "e" }));
try { print(absent({})); } catch (e) { print(e.name); }
