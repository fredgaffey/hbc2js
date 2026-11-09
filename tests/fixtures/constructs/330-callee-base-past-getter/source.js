// review-1110 objlit/fold: object-literal-arg kind B (callee base,
// docs/specs/passes/20-object-literal.md section 9) moved the global read `G`
// past intervening statements that `isPureStmt` calls pure but that run user
// code: a global read (`H`, a getter here) and `a + b` (valueOf). The original
// logs "get G" first; the decompiled program logged the getter/valueOf first.
Object.defineProperty(globalThis, "G", { get: function () { print("get G"); return { m: function (a) { print("m", a); } }; }, configurable: true });
Object.defineProperty(globalThis, "H", { get: function () { print("get H"); return 5; }, configurable: true });
function t10() {
  var c = G;
  var k = H;
  c.m(k);
  print(k);
}
t10();
function t10b(a, b) {
  var c = G;
  var s = a + b;
  c.m(s);
  print(s);
}
t10b({ valueOf: function () { print("valueOf"); return 1; } }, 2);
function t10c() {
  var c = G;
  var k = Undef;
  c.m(k);
}
try { t10c(); } catch (e) { print("caught", e.name); }
