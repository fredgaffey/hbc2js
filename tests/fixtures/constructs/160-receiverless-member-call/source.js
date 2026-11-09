// A function read off an object but called WITHOUT that object as receiver:
// `(0, ns.fn)(x)`, the shape Babel's module interop emits for every imported
// call. The callee must see `this === undefined`; the plain method call
// `ns.fn(x)` beside it must keep `ns` as its receiver.
"use strict";
function describe(a) {
  return (this === undefined ? "no receiver" : "receiver " + this.tag) + " " + a;
}
function viaSeq(ns, x) {
  return (0, ns.fn)(x) + "|" + (0, ns["fn"])(x + 1);
}
function viaMethod(ns, x) {
  return ns.fn(x);
}
var ns1 = { tag: "one", fn: describe };
var ns2 = { tag: "two", fn: describe };
print(viaSeq(ns1, 1));
print(viaSeq(ns2, 3));
print(viaMethod(ns1, 5));
print(viaMethod(ns2, 7));
