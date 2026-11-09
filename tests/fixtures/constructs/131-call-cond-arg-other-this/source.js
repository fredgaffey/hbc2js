// Negative twin of 130: the method is read from one object but called with a
// DIFFERENT `this` (explicit `.call`), or the read value is used twice. A
// rewrite to `o.m(...)` would change the receiver; it must stay as it is.
var other = { name: "other" };
var o = { name: "o", m: function (x) { return this.name + ":" + x; } };
function otherThis(a, c) { var f = a.m; var r = c ? 1 : 2; return f.call(other, r); }
function twice(a, c) { var f = a.m; var r = c ? 1 : 2; return f.call(a, r) + "," + f.call(other, r); }
function swapped(a, b, c) { var f = a.m; return f.call(b, c ? 1 : 2); }
print(otherThis(o, true), otherThis(o, false));
print(twice(o, true));
print(swapped(o, other, true), swapped(o, o, false));
