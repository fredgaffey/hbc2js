// 340: a fold inside a loop body whose moved expression reads a loop-carried
// register (`i`, read at the top of the body and redefined at its bottom).
// The expression-only check used to flag `i` as "read before its first def"
// in the body list -- true before the fold as well -- and drop every fold in
// that body (roundtrip `diff:GetById(reg)` bucket: `s[i]()` stayed a
// `Reflect.apply` and its global read shifted every later register).
function runAll(s, i) {
  "use strict";
  while (i < s.length) {
    s[i]();
    i = i + 1;
  }
  return i;
}
function sumTags(xs) {
  var n = 0;
  for (var k = 0; k < xs.length; k++) {
    var h = xs[k].handler;
    n = n + h.call(xs[k]);
  }
  return n;
}
var log = [];
var fns = [function () { log.push("a"); }, function () { log.push(this.length); }];
print(runAll(fns, 0), log.join(","));
var calls = [];
var tag = { tag: "T", handler: function () { calls.push(this.tag); return 2; } };
print(sumTags([tag, tag]), calls.join(""));
// negative twin: the getter on the element read must still run before the call
var order = [];
var arr = [];
Object.defineProperty(arr, 0, { get: function () { order.push("get"); return function () { order.push("call"); }; } });
print(runAll(arr, 0), order.join(">"));
