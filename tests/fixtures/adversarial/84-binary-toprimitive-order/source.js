// Binary operators convert left before right; relational, equality and ** too.
var log = [];
function mk(n) { return { valueOf: function () { log.push("v" + n); return n; }, toString: function () { log.push("t" + n); return "" + n; } }; }
var a = mk(2), b = mk(3);
var res = [a - b, a < b, a > b, a <= b, a ** b, a * b, a % b, a & b, a == 2, 2 == b, a != b];
print(res.join(","), log.join(" ")); log = [];
print(b >= a, a >>> b, -a, +b, ~a, log.join(" ")); log = [];
var arr = [a, b];
arr.sort(function (x, y) { return y - x; });
print(arr[0] === b, log.join(" ")); log = [];
print(mk(1) in { 1: 1 }, log.join(" ")); log = [];
var obj = {}; obj[mk(5)] = 1;
print(Object.keys(obj).join(","), log.join(" "));
