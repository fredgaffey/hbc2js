// 310: review-1110 guard probes -- global reads whose `globalThis` register is
// reused (docs/specs/passes/03-global-access.md section 4 condition 7) in
// shapes that could break a local proof: a captured local named `globalThis`,
// a counting getter on the global object, a global created/deleted mid-loop,
// generator/async resumption, try/finally, for-in over the global object.
var hits = 0;
Object.defineProperty(globalThis, "Counted310", { configurable: true, get: function () { hits++; return hits; } });
function shadowGT(a) {
  var globalThis = { Math: "fake" };
  var peek = function () { return typeof globalThis.Math; };
  var t = a > 1 ? a : 1;
  t = t + Math.max(a, 2);
  return t + peek();
}
function counted(a) {
  var t = a ? a : 0;
  t = t || Counted310;
  t = t + Counted310;
  return t;
}
function lateLoop(n) {
  var s = "";
  for (var i = 0; i < n; i++) {
    var v = i > 2 ? i : -i;
    if (i === 1) globalThis.Late310 = 5;
    if (i === 3) delete globalThis.Late310;
    try { s += v + Late310; } catch (e) { s += "E"; }
  }
  return s;
}
function* gen(a) {
  var t = a ? a : 1;
  t = yield t;
  t = t || Math.abs(-a);
  yield t + Math.floor(1.5);
  try { t = yield; } finally { t = t + Math.round(0.4); }
  return t;
}
async function asy(a) {
  var t = a ? a : 1;
  t = await t;
  t = t + Math.min(a, 0);
  return t;
}
function tf(a) {
  var t = a ? a : 0;
  try {
    t = t || Gone310;
  } catch (e) {
    t = "c";
  } finally {
    t = t + typeof JSON.stringify;
  }
  return t;
}
function forIn(o) {
  var n = 0;
  for (var k in o) {
    var t = o[k] ? k : 0;
    n = n + (t ? Math.sign(1) : 0);
  }
  return n;
}
print(shadowGT(0), shadowGT(3), counted(0), counted(1), hits);
print(lateLoop(5));
var g = gen(0);
print(g.next().value, g.next(0).value, g.next().value, JSON.stringify(g.next(7)));
print(tf(0), tf(1), forIn({ a: 1, b: 0, c: 2 }));
asy(3).then(function (v) { print("async", v); });
