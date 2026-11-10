// in / instanceof: operand order, Symbol.hasInstance, Proxy has trap.
var log = [];
function s(x, tag) { log.push(tag); return x; }
var Even = {};
Even[Symbol.hasInstance] = function (v) { log.push("hasInstance " + v); return v % 2 === 0; };
print(s(4, "L") instanceof s(Even, "R"), s(3, "L2") instanceof s(Even, "R2"), log.join(" ")); log = [];
var hp = new Proxy({}, { has: function (t, k) { log.push("has " + String(k)); return k === "yes"; } });
print(s("yes", "key") in s(hp, "obj"), s("no", "key2") in hp, log.join(" ")); log = [];
function F() {}
var proto = F.prototype;
var obj = new F();
var cnt = 0;
var G = new Proxy(F, { get: function (t, k) { cnt++; log.push("G.get " + String(k)); return t[k]; } });
print(obj instanceof G, cnt, log.join(" ")); log = [];
try { s(1, "l") instanceof s({}, "r"); } catch (e) { print("TE", e instanceof TypeError, log.join(" ")); }
log = [];
try { s("k", "l") in s(5, "r"); } catch (e) { print("TE", e instanceof TypeError, log.join(" ")); }
