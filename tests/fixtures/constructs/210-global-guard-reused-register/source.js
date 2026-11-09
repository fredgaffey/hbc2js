// 210: a global read whose `globalThis` register was reused by an earlier
// value in the same function (roundtrip `diff:JmpTrue(label)` bucket).
function pick(a, b) {
  var t = a > b ? a : b;
  t = t || Math.max(a, b);
  return t + Math.min(a, b);
}
function loopy(xs) {
  var s = 0;
  for (var i = 0; i < xs.length; i++) {
    var v = xs[i];
    s = v ? s + Math.abs(v) : s;
  }
  return s;
}
function def(o, k, get) {
  var has = Object.prototype.hasOwnProperty.call(o, k);
  if (!has) {
    Object.defineProperty(o, k, { enumerable: true, get: get });
  }
  return o;
}
// negative twin 1: the name is genuinely absent -- the read must still throw.
function absent(a) {
  var t = a ? a : 0;
  t = t || noSuchGlobal210;
  return t;
}
// negative twin 2: a local shadows the global name.
function shadow(a) {
  var Math = { max: function (x, y) { return "local" + x + y; } };
  var t = a ? a : 0;
  t = t || Math.max(a, 1);
  return t;
}
var o = def({}, "x", function () { return 7; });
print(o.x, pick(3, 4), pick(0, 0), loopy([1, -2, 0, 3]));
print(absent(5));
try { print(absent(0)); } catch (e) { print(e.name); }
print(shadow(0), shadow(2));
