// x op= rhs reads x BEFORE rhs runs, even when rhs reassigns x (locals, captured, global).
var g = 1;
function local() {
  var x = 1;
  x += (x = 10, 5);
  var y = 2;
  y = y * (y = 3);
  var z = 1;
  z += z++ + ++z;
  return [x, y, z].join(",");
}
print(local());
function captured() {
  var c = 1;
  function bump() { c = 100; return 1; }
  c += bump();
  var d = 2;
  d = d + (function () { d = 50; return 1; })();
  return c + "," + d;
}
print(captured());
g += (g = 7, 1);
print(g);
var s = "a";
s += (s = "zz", "b");
print(s);
var o = { v: 1 };
o.v += (o.v = 40, 2);
print(o.v);
var n = 5;
n -= (n = 1) - n;
print(n);
