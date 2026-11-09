// `f.call(t, ...)`: from v98 hermesc emits a JmpBuiltinIs diamond (fast path
// when `f.call` is the builtin Function.prototype.call, generic call
// otherwise). Both arms must decompile to the one `f.call(...)`; a shadowed
// `.call` must still take the generic path.
function show(x, y) {
  return "this=" + this.tag + " x=" + x + " y=" + y;
}
function callTwo(f, t, a, b) {
  return f.call(t, a, b);
}
function callNone(f) {
  return f.call();
}
function callConst(o, t) {
  o.m.call(t, "k");
  return o.n.call(t, 1, 2, 3);
}
function callMany(f, t) {
  return f.call(t, 1, 2, 3, 4, 5);
}
var ctx = { tag: "T" };
print(callTwo(show, ctx, 1, 2));
print(callNone(function () { return typeof this; }));
print(callConst({ m: function (k) { print("m " + this.tag + " " + k); }, n: function (a, b, c) { return this.tag + (a + b + c); } }, ctx));
print(callMany(function () { return this.tag + arguments.length; }, ctx));
// negative twin: `.call` shadowed on the callee is the generic path, not the builtin
var fake = function () { return "real"; };
fake.call = function (t, a) { return "shadowed " + t.tag + " " + a; };
print(callTwo(fake, ctx, 7, 8));
// overriding Function.prototype.call itself: still observed by every site
var saved = Function.prototype.call;
Function.prototype.call = function (t) { return "overridden " + typeof t; };
print(callTwo(show, ctx, 1, 2));
Function.prototype.call = saved;
print(callTwo(show, ctx, 3, 4));
