// roundtrip-paramenv negative twins: a captured parameter whose environment
// slot is written again after entry (in the body, in a closure, or by a
// default-value initialiser) is a different variable from the incoming
// argument, so it must keep its own binding. Each function prints values
// that differ if the decompiler conflated the slot with the parameter.
function reassignedInBody(a, b) {
  'use strict';
  var h = function () { return a; };
  var before = h();
  a = a * b;
  return before + ':' + h() + ':' + arguments[0];
}
print(reassignedInBody(3, 4));

function reassignedInClosure(a, b) {
  'use strict';
  function set(v) { a = v; }
  function get() { return a; }
  var x = get();
  set(b);
  return x + ':' + get() + ':' + arguments[0];
}
print(reassignedInClosure('p', 'q'));

function defaulted(a = 5, b) {
  return function () { return a + b; };
}
print(defaulted(undefined, 1)(), defaulted(2, 1)());

function reassignedFirst(a) {
  a = a + 1;
  return function () { return a; };
}
print(reassignedFirst(1)());

function sloppyAliased(a, b) {
  function get() { return a; }
  b = get();
  return b + ':' + arguments.length;
}
print(sloppyAliased(7, 8));
