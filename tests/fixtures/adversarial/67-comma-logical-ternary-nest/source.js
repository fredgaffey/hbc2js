// Deeply nested comma / logical / ternary with side effects at every node.
var log = [];
function s(x) { log.push(String(x)); return x; }
var r1 = (s(1), s(0)) ? (s(2), s(3)) : (s(0) || (s(4), s(null))) ?? s(5);
print(r1, log.join(",")); log = [];
var r2 = s(0) || s("") && s(6) || (s(7) ? s(8) && s(0) : s(9));
print(r2, log.join(",")); log = [];
var r3 = (s(1) && (s(0) ? s(10) : (s(11), s(undefined)))) ?? s(12);
print(r3, log.join(",")); log = [];
var x = 0;
var r4 = (x = s(1), x++ ? s(13) : s(14), x) ? s(x) : s(-1);
print(r4, x, log.join(",")); log = [];
for (var i = 0; s(i) < 2 && s("t"); i++, s("inc")) {}
print(log.join(","));
