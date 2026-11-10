// for-of / for-in with member-expression targets: target re-evaluated each iteration.
var log = [];
var sink = {};
function tgt(n) { log.push("tgt" + n); return sink; }
var n = 0;
for (tgt(n++).v of ["a", "b"]) { log.push("body " + sink.v); }
print(log.join(" ")); log = [];
var keys = [];
var h = { arr: [] };
var i = 0;
for (h.arr[i++] in { x: 1, y: 2, z: 3 }) {}
print(h.arr.join(","), i);
var it = {};
it[Symbol.iterator] = function () {
  var c = 0;
  return {
    next: function () { c++; log.push("next" + c); return { done: c > 3, value: c }; },
    return: function () { log.push("return"); return {}; },
  };
};
for (var v of it) { if (v === 2) break; log.push("v" + v); }
print(log.join(" ")); log = [];
try { for (var w of it) { throw new Error("stop" + w); } } catch (e) { log.push(e.message); }
print(log.join(" "));
