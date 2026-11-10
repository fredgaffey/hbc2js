// new with an observable callee expression and observable arguments.
var log = [];
function C(a, b) { log.push("ctor " + a + "," + b); this.s = a + b; }
var ns = { get C() { log.push("get C"); return C; } };
function a(x) { log.push("arg " + x); return x; }
var o1 = new ns.C(a(1), a(2));
print(o1.s, log.join(" ")); log = [];
function pick() { log.push("pick"); return C; }
var o2 = new (pick())(a(3), a(4));
print(o2.s, log.join(" ")); log = [];
var o3 = new ns.C(...[a(5), a(6)]);
print(o3.s, log.join(" ")); log = [];
try { new (a(7))(a(8)); } catch (e) { print(e instanceof TypeError, log.join(" ")); }
log = [];
var o4 = new ns.C;
print(String(o4.s), log.join(" "));
