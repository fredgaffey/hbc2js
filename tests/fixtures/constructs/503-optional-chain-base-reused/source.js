"use strict";
function f(m, k) {
  var e = m[k];
  if (e?.pubkey) return k + ":" + e.pubkey;
  return "none";
}
function g(a) {
  var s = a[0];
  if (s?.stack) return "stack";
  return typeof s === "string" ? s.length : -1;
}
print([f({ a: { pubkey: "P" } }, "a"), f({}, "b"), g([{ stack: 1 }]), g(["abc"]), g([])].join(","));
