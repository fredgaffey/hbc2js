// Assignment: target object and key evaluated before the RHS; chained assignment.
var log = [];
function s(x, tag) { log.push(tag); return x; }
var o = {}, p = {};
s(o, "obj").x = s(1, "rhs");
print(o.x, log.join(" ")); log = [];
s(o, "o")[s("y", "ky")] = s(p, "p")[s("z", "kz")] = s(2, "v");
print(o.y, p.z, log.join(" ")); log = [];
var a = [0, 0, 0], i = 0;
a[i++] = a[i++] = i++;
print(a.join(","), i);
var q = { n: 1 };
var old = q;
q.n = (q = { n: 2 }, 5);
print(old.n, q.n);
var arr = [1, 2];
arr[arr.length] = arr.length;
print(arr.join(","));
var r;
r = (s(0, "first"), r = s(9, "inner")) + 1;
print(r, log.join(" "));
