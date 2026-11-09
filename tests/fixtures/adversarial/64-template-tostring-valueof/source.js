// Template literal substitutions use ToString (toString first), + uses valueOf first.
var log = [];
function mk(n) {
  return {
    toString: function () { log.push("toString " + n); return "T" + n; },
    valueOf: function () { log.push("valueOf " + n); return n; },
  };
}
var a = mk(1), b = mk(2);
var t = `<${a}|${b}>`;
print(t, log.join(" ")); log = [];
var p = "<" + a + "|" + b + ">";
print(p, log.join(" ")); log = [];
var q = a + b;
print(q, log.join(" ")); log = [];
var r = `${a + b}${String(a)}`;
print(r, log.join(" ")); log = [];
var s = "" + `${b}` + a;
print(s, log.join(" ")); log = [];
var u = [a, b].join("-");
print(u, log.join(" "));
