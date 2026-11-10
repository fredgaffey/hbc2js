// o[k()] += v() — key computed once, get before RHS, set after RHS.
var log = [];
var store = { p: 10, q: "s" };
var o = new Proxy(store, {
  get: function (t, k) { log.push("get " + String(k)); return t[k]; },
  set: function (t, k, v) { log.push("set " + String(k) + "=" + v); t[k] = v; return true; },
});
function k(n) { log.push("key " + n); return n; }
function v(x) { log.push("val " + x); return x; }
o[k("p")] += v(5);
print(log.join(" | ")); log = [];
o[k("q")] += v(1) + v(2);
print(log.join(" | ")); log = [];
o[k("p")] *= (o[k("p")] = v(3));
print(store.p, log.join(" | ")); log = [];
o.p -= v(1);
print(store.p, log.join(" | ")); log = [];
o[k("p")] <<= v(2);
print(store.p, log.join(" | "));
