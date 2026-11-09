// fix-jsx-read-order probe: the element factory read (`R.createElement`,
// `M.jsx`) must stay ordered against the type/props work around it when
// jsx-recover turns the call into an element (spec passes/08 section 10).
var log = [];
function makeR(tag) {
  return {
    get createElement() {
      log.push(tag + ".createElement");
      return function (t, p) { return [typeof t === "string" ? t : t.name, p === null ? null : Object.keys(p).map(function (k) { return k + "=" + p[k]; }).join("+")]; };
    },
  };
}
function makeM(tag) {
  return {
    get jsx() {
      log.push(tag + ".jsx");
      return function (t, p) { return [typeof t === "string" ? t : t.name, Object.keys(p).map(function (k) { return k + "=" + p[k]; }).join("+")]; };
    },
  };
}
var X = {
  get Text() { log.push("X.Text"); return { name: "Text" }; },
};
var View = { name: "View" };
var n = 0;
function g() { log.push("g"); return ++n; }
// A: type read held in a register before a fused factory read.
function a(R) {
  var T = X.Text;
  return R.createElement(T, null);
}
// B: impure prop value computed before a fused factory read.
function b(R) {
  var v = g();
  return R.createElement(View, { a: v });
}
// C: automatic runtime, type read before the spilled factory read.
function c(M) {
  var T = X.Text;
  return (0, M.jsx)(T, {});
}
// D: classic, work between the factory read and the call (unfused form).
function d(R) {
  return R.createElement(View, { a: g() });
}
// E: automatic, work between the factory read and the call.
function e(M) {
  return (0, M.jsx)(View, { a: g() });
}
// F: automatic, type read in place after the factory read.
function f(M) {
  return (0, M.jsx)(X.Text, { a: g() });
}
var out = [a(makeR("A")), b(makeR("B")), c(makeM("C")), d(makeR("D")), e(makeM("E")), f(makeM("F"))];
print(log.join(","));
print(JSON.stringify(out));
