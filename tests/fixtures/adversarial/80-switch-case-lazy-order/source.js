// Switch: discriminant once, case tests evaluated lazily in order, default last-resort.
var log = [];
function s(x) { log.push(String(x)); return x; }
function run(v) {
  log = [];
  var out = [];
  switch (s(v)) {
    case s(1): out.push("one");
    case s(2): out.push("two"); break;
    default: out.push("def");
    case s(3): out.push("three");
  }
  return out.join("+") + " [" + log.join(",") + "]";
}
print(run(1)); print(run(2)); print(run(3)); print(run(9));
var o = { valueOf: function () { log.push("valueOf"); return 1; } };
log = [];
switch (o) { case 1: print("loose?"); break; default: print("strict", log.length); }
