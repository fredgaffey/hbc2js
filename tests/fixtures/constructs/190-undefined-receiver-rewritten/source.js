// A plain call reached along several paths. hermesc loads `undefined` into
// the same `this` register once per path, so the decompiled function writes
// that register `undefined` more than once before the call(s). Every write is
// `undefined`, so each call is a plain `fn(...)` with `this === undefined`.
// `mixed` (negative twin) calls the same function as a method on one path:
// its receiver must stay the object.
"use strict";
function who(a, b) {
  return (this === undefined ? "undef" : "this=" + this.tag) + ":" + a.tag + ":" + b;
}
function joinAfterLabel(fn, e, m) {
  if (e.a) {
    if (m.includes("x")) {
      e.message = "has " + m;
    }
    return fn(e, 1);
  }
  return fn(e, 2);
}
function loopThenTail(fn, e) {
  for (var i = 0; i < 2; i++) {
    if (e[i]) return fn(e, i);
  }
  return fn(e, 9);
}
function bySwitch(fn, e) {
  switch (e.k) {
    case 1:
      return fn(e, 1);
    case 2:
      e.z = 1;
      return fn(e, 2);
    default:
      return fn(e, 3);
  }
}
function mixed(o, e) {
  if (e.a) return o.m(e, 1);
  return who(e, 2);
}
var obj = { tag: "o", m: who };
print(joinAfterLabel(who, { a: 1, tag: "e1" }, "x"), joinAfterLabel(who, { tag: "e2" }, "y"));
var arr = [0, 1];
arr.tag = "arr";
print(loopThenTail(who, arr), loopThenTail(who, Object.assign([0, 0], { tag: "zz" })));
print(bySwitch(who, { k: 1, tag: "k1" }), bySwitch(who, { k: 2, tag: "k2" }), bySwitch(who, { k: 7, tag: "k7" }));
print(mixed(obj, { a: 1, tag: "m1" }), mixed(obj, { tag: "m2" }));
