// Object literal: each computed key evaluated right before its value, spread in place.
var log = [];
function s(x) { log.push(String(x)); return x; }
var spr = { get g() { log.push("spread-get g"); return "G"; } };
var o = {
  a: s("va"),
  [s("kb")]: s("vb"),
  ...spr,
  [s("kc")]: s("vc"),
  a: s("va2"),
  get x() { return "never"; },
};
print(JSON.stringify(o), log.join(" ")); log = [];
var key = { toString: function () { log.push("key.toString"); return "tk"; } };
var o2 = { [key]: s(1), [s("k2")]: s(2) };
print(JSON.stringify(o2), log.join(" ")); log = [];
var o3 = { __proto__: { inh: 1 }, ["__proto__"]: 5 };
print(o3.inh, Object.keys(o3).join(","));
