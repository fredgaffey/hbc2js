// Spread drives the iterator protocol; interleave with other argument side effects.
var log = [];
function iter(name, n) {
  var obj = {};
  obj[Symbol.iterator] = function () {
    log.push(name + ".iter");
    var i = 0;
    return { next: function () { i++; log.push(name + ".next" + i); return { done: i > n, value: name + i }; } };
  };
  return obj;
}
function s(x) { log.push("s" + x); return x; }
function f() { return Array.prototype.join.call(arguments, ","); }
var r = f(s(0), ...iter("A", 2), s(1), ...iter("B", 1));
print(r); print(log.join(" ")); log = [];
var arr = [s(2), ...iter("C", 2), s(3)];
print(arr.join(",")); print(log.join(" ")); log = [];
var [x, y] = iter("D", 5);
print(x, y, log.join(" "));
