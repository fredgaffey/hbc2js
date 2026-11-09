// ++/-- on accessors and computed keys: one get, one set, ToNumeric via valueOf.
var log = [];
var store = { p: { valueOf: function () { log.push("valueOf"); return 4; } }, q: "7" };
var o = new Proxy(store, {
  get: function (t, k) { log.push("get " + String(k)); return t[k]; },
  set: function (t, k, v) { log.push("set " + String(k) + "=" + v); t[k] = v; return true; },
});
function k(n) { log.push("key " + n); return n; }
var r = o[k("p")]++;
print(r, store.p, log.join(" | ")); log = [];
var r2 = --o.q;
print(r2, typeof store.q, log.join(" | ")); log = [];
var r3 = o.q++ + o.q++;
print(r3, store.q, log.join(" | ")); log = [];
var s = "5"; var t = s++;
print(typeof t, t, s);
var b = 10n; b++;
print(String(b));
var u; u++;
print(u);
