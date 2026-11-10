// ||= &&= ??= : get always, set only when the RHS is taken, RHS lazily evaluated.
var log = [];
var store = { a: 0, b: 1, c: null, d: "x" };
var o = new Proxy(store, {
  get: function (t, k) { log.push("get " + String(k)); return t[k]; },
  set: function (t, k, v) { log.push("set " + String(k) + "=" + v); t[k] = v; return true; },
});
function s(x) { log.push("rhs " + x); return x; }
function k(n) { log.push("key " + n); return n; }
o.a ||= s(5); o.b ||= s(6);
print(log.join(" | ")); log = [];
o[k("a")] &&= s(0); o[k("c")] &&= s(7);
print(log.join(" | ")); log = [];
o.c ??= s(8); o.d ??= s(9);
print(log.join(" | ")); log = [];
var v = null; var w = (v ??= s(1), v ||= s(2));
print(v, w, log.join(" | "));
