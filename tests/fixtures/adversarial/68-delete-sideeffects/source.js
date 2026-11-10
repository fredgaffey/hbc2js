// delete with computed keys, Proxy deleteProperty traps, and non-configurable props.
var log = [];
function k(n) { log.push("key " + n); return n; }
var t = { a: 1, b: 2 };
var p = new Proxy(t, {
  deleteProperty: function (tt, key) { log.push("delete " + String(key)); return key !== "b" ? delete tt[key] : false; },
});
print(delete p[k("a")], "a" in t, log.join(" | ")); log = [];
print(delete p.b, "b" in t, log.join(" | ")); log = [];
var fr = Object.freeze({ z: 1 });
print(delete fr.z, delete fr[k("y")], log.join(" | ")); log = [];
var arr = [1, 2, 3];
print(delete arr[k(1)], arr.length, 1 in arr, log.join(" | ")); log = [];
function side() { log.push("side"); return {}; }
print(delete side().x, log.join(" | "));
var n = (log.push("lhs"), delete t.missing) + (log.push("rhs"), 1);
print(n, log.join(" | "));
