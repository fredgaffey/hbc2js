// 311: review-1110 this probes -- plain calls whose `this` register is
// reused for a method receiver (docs/specs/passes/04-call-shape.md R3h/R3i)
// across branches, loops, exception edges, generators and async frames. The
// callee reports the `this` it received, strict and sloppy.
function who() { "use strict"; return this === undefined ? "U" : this === null ? "N" : typeof this === "object" && this.tag ? this.tag : typeof this; }
function sloppy() { return this === globalThis ? "G" : this && this.tag ? this.tag : typeof this; }
var o = { tag: "o", m: who, s: sloppy };
function branches(c, f) {
  if (c) return o.m(1);
  return f(2);
}
function loop(n, f) {
  var s = "";
  for (var i = 0; i < n; i++) {
    if (i & 1) s += o.m(i);
    else s += f(i);
  }
  return s;
}
function tc(f) {
  var s = "";
  try {
    s += o.m();
    throw new Error("x");
  } catch (e) {
    s += f();
  } finally {
    s += f() + o.s();
  }
  return s + f();
}
function* gen(f) {
  var a = yield o.m();
  var b = yield f();
  yield o.s() + f(a, b);
  return f();
}
async function asy(f) {
  var a = o.m();
  await null;
  var b = f();
  await 0;
  return a + b + o.m() + f();
}
function forin(obj, f) {
  var s = "";
  for (var k in obj) s += k + (obj[k] ? obj.m() : f());
  return s;
}
function cond(c, f) {
  return (c ? o.m : f)() + (0, o.m)() + (o.m)() + o.m?.() + f?.() + (o.n?.m)?.();
}
function tagged(f) {
  return f`x` + o.m`y`;
}
function sw(k, f) {
  var s = "";
  switch (k) {
    case 0: s += o.m();
    case 1: s += f(); break;
    default: s += o.m() + f();
  }
  return s;
}
print(branches(1, who), branches(0, who), branches(0, sloppy));
print(loop(4, who), loop(3, sloppy));
print(tc(who), tc(sloppy));
var g = gen(who);
print(g.next().value, g.next(1).value, g.next(2).value, g.next().value);
print(forin({ a: 1, b: 0, m: who }, who));
print(cond(0, who), cond(1, sloppy));
print(tagged(who));
print(sw(0, who), sw(1, sloppy), sw(5, who));
asy(who).then(function (v) { print("async", v); });
