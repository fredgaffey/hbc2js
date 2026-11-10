// Destructuring: computed keys, defaults and gets interleave in source order.
var log = [];
var src = new Proxy({ a: undefined, b: 2, c: 3, d: 4 }, {
  get: function (t, k) { log.push("get " + String(k)); return t[k]; },
  ownKeys: function (t) { log.push("ownKeys"); return Reflect.ownKeys(t); },
});
function k(n) { log.push("key " + n); return n; }
function dflt(n) { log.push("default " + n); return n; }
var { a = dflt("A"), [k("b")]: b = dflt("B"), [k("z")]: z = dflt("Z"), c } = src;
print(a, b, z, c); print(log.join(" | ")); log = [];
var { b: bb, ...rest } = src;
print(bb, JSON.stringify(rest)); print(log.join(" | ")); log = [];
function f({ a = dflt(1) } = dflt({}), [x = dflt(2)] = [], y = dflt(a + x)) { return a + x + y; }
print(f()); print(log.join(" | "));
