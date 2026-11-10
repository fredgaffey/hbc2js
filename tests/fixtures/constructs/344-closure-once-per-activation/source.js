// review-1110 iife/private negative control: closures whose site runs at most
// once per activation keep their per-activation identity (recursion, a
// switch fall-through, a site before the first yield) and closures in a
// do-while are distinct per iteration.
function rec(d, acc) { var f = function () { return d; }; acc.push(f); if (d > 0) rec(d - 1, acc); return acc; }
var r = rec(2, []);
print('rec:', r[0] !== r[1], r[1] !== r[2], r.map(function (f) { return f(); }).join());
function mk() { return function () {}; }
print('per call:', mk() !== mk());
function sw(v) { var a = []; switch (v) { case 1: a.push(function () {}); case 2: a.push(function () {}); } return a.length + ':' + (a[0] !== a[1]); }
print('switch:', sw(1), sw(2));
function dw() { var a = []; do { a.push(function () {}); } while (a.length < 2); return a[0] !== a[1]; }
print('do-while:', dw());
function* g() { var f = function () {}; yield f; yield f; }
var it = g();
print('gen same:', it.next().value === it.next().value);
