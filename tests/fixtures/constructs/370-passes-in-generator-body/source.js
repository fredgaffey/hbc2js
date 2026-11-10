// 370: stage-B passes inside a lowered generator/async resume closure
// (docs/specs/passes/00-LADDER.md "Resumable bodies"). At v84/94/96 the body
// below is emitted as `return function (__sent, ...) { switch (__state) ... }`
// sharing the enclosing frame's registers; global reads, f.call shapes and
// object literals inside it must fold, while a value stored before a yield
// (a different resume) must never be trusted after it.
function* walk(a) {
  var t = a ? a : 1;
  t = yield t + Math.abs(-a);
  var o = { x: t, y: Math.max(t, 2), z: "k" };
  yield o.x + o.y;
  var f = function (q) { return q + (this === undefined ? 1 : 2); };
  var s = f.call(undefined, t);
  s = s + f.call(o, 1);
  yield s;
  return JSON.stringify(o) + typeof Number.isFinite;
}
function* carry(n) {
  var acc = 0;
  for (var i = 0; i < n; i++) {
    var got = yield i;
    acc = acc + (got ? Math.floor(got) : Math.ceil(i / 2));
  }
  try {
    var w = yield acc;
    if (w) throw new Error("boom" + w);
  } catch (e) {
    acc = acc + String(e.message).length + Math.round(0.6);
  }
  return acc;
}
async function later(a) {
  var t = a ? a : 1;
  var p = { v: t, m: Math.min(t, 5) };
  t = await t;
  var g = function (u) { return u * 2; };
  t = t + g.call(undefined, p.v) + Math.max(p.m, 1);
  var q = await Promise.resolve(t);
  return { q: q, s: String(q).length };
}
var w = walk(3);
print(w.next().value, w.next(4).value, w.next().value, JSON.stringify(w.next()));
var c = carry(3);
print(c.next().value, c.next(2.5).value, c.next(0).value, c.next().value, c.next(7).value, JSON.stringify(c.next()));
var c2 = carry(1);
print(c2.next().value, c2.next().value, JSON.stringify(c2.next(0)));
later(3).then(function (v) { print("async", v.q, v.s); });
later(0).then(function (v) { print("async0", JSON.stringify(v)); });
