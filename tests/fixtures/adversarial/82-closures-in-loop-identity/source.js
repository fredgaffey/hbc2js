// Closures created in loops are distinct objects; each var-loop closure shares state.
var fs = [];
for (var i = 0; i < 3; i++) { fs.push(function () { return i; }); }
print(fs[0] === fs[1], fs[1] === fs[2], new Set(fs).size, fs.map(function (f) { return f(); }).join(","));
var gs = [];
for (var j = 0; j < 3; j++) { (function (jj) { gs.push(function () { return jj; }); })(j); }
print(gs[0] === gs[1], gs.map(function (f) { return f(); }).join(","));
function maker() { return function () {}; }
var a = maker(), b = maker();
print(a === b, typeof a);
var protoSet = [];
for (var k = 0; k < 2; k++) { var fn = function () {}; fn.prototype.tag = k; protoSet.push(fn); }
print(protoSet[0].prototype === protoSet[1].prototype, protoSet[0].prototype.tag, protoSet[1].prototype.tag);
var objs = [];
for (var m = 0; m < 2; m++) { objs.push({ f: function () { return this; } }); }
print(objs[0].f === objs[1].f, objs[1].f() === objs[1]);
var counters = [];
for (var c = 0; c < 2; c++) { counters.push((function () { var n = 0; return function () { return ++n; }; })()); }
counters[0](); counters[0]();
print(counters[0](), counters[1]());
