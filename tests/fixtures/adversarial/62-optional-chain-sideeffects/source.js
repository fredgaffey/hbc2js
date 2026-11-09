// Optional chaining short-circuits the whole chain, including argument evaluation.
var log = [];
function s(x) { log.push("s" + x); return x; }
var o = { m: function (a) { log.push("m(" + a + ")"); return { n: null }; } };
var nul = null;
var r1 = nul?.m(s(1)).n.z(s(2));
print(String(r1), log.join(",")); log = [];
var r2 = o?.[s("m")](s(3))?.n?.z(s(4));
print(String(r2), log.join(",")); log = [];
var r3 = o.missing?.(s(5));
print(String(r3), log.join(",")); log = [];
var r4 = (nul?.a) === undefined;
print(r4);
var cnt = 0;
var g = { get h() { cnt++; return cnt > 1 ? { v: cnt } : undefined; } };
print(String(g.h?.v), String(g.h?.v), cnt);
try { (nul?.a).b; } catch (e) { print("TypeError?", e instanceof TypeError); }
