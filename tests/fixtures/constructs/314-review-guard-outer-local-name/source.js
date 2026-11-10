// 314: review-1110 guard probe -- an undeclared global (TryGetById + guard)
// read in a nested function, while the enclosing top-level code snapshots
// the same global through an explicit `globalThis.X` member read, which
// var-naming may name `X`. The folded bare read in the nested function must
// keep reaching the live global, not that outer local.
globalThis.Dyn314 = function () { return "a"; };
function reader(a) {
  var t = a ? a : 0;
  t = t || Dyn314();
  return t;
}
print(reader(0));
var snap = globalThis.Dyn314;
print(snap());
globalThis.Dyn314 = function () { return "b"; };
print(reader(0), snap(), reader(2));
