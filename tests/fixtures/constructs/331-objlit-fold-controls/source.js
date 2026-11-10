// review-1110 objlit/fold negative controls: probes of object-literal-arg
// kind A and expr-rebuild's carried live-in reads that hold (fn decl
// reassigned by a callee, assignments in earlier arguments, this in arrows,
// loop-carried registers, try first-def, generators). Sloppy
// `arguments[0] = v` is not probed here: Hermes arguments are unmapped, so
// node and the VM disagree on such a source itself.
function show2(x, o) { print(typeof o.a, x); }
function t5() {
  function g() { return 1; }
  function h() { g = 2; return 0; }
  globalThis.hh = h;
  var o = { a: g, b: 1 };
  show2(hh(), o);
  print(typeof g);
}
t5();
function show3(x, y, o) { print(x, y, o.a, o.b); }
function t6(n, m) {
  var r = n;
  var o = { a: r, b: m };
  show3(r = n * 2, m = r + 1, o);
  print(r, m);
}
t6(3, 4);
function t6b(n) {
  var o = { a: n, b: this === undefined };
  show3(n = n + 1, (function () { return 0; })(), o);
}
t6b(5);
var arrow = function (n) { var self = this; return () => { var o = { a: this === self, b: n }; show3(n++, n++, o); }; };
arrow.call({}, 1)();
function t7(n) {
  var a = 0, b = 0, out = [];
  for (var i = 0; i < n; i++) {
    if (i > 0) out.push(b, a);
    var t = a;
    b = t + i;
    a = i * 10 + b;
  }
  print(out.join(","));
}
t7(4);
function t7b(n) {
  var x, y = 1;
  do { var p = x; x = y + n; y = p === undefined ? 100 : p; print(p, x, y); } while (--n > 0);
}
t7b(3);
function t7c(arr) {
  var prev, s = "";
  for (var k = 0; k < arr.length; k++) { var q = prev; s += String(q) + "|" + Math.max(arr[k], 0); prev = arr[k] * 2; }
  print(s);
}
t7c([1, 2, 3]);
function t8(f) {
  var v, w;
  for (var i = 0; i < 2; i++) {
    try { w = v; v = f(i); } catch (e) { print("caught", w, v); }
    print(i, v, w);
  }
}
t8(function (i) { if (i === 1) throw new Error("x"); return i + 5; });
function* gen(n) {
  var acc, last;
  for (var i = 0; i < n; i++) { var o = { a: last, i: i }; last = yield Math.max(acc = i, 0); print(JSON.stringify(o), acc); }
}
var it = gen(3); it.next(); it.next("A"); it.next("B"); it.next("C");
