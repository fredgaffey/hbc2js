// 313: review-1110 guard probe -- a top-level function declaration is a
// global property; reassigning that property must be visible to a later
// global read in another function, after its guard is folded to a bare name.
function helper313() { return "orig"; }
function reader(a) {
  var t = a ? a : 0;
  t = t || helper313();
  return t;
}
function loopReader(n) {
  var s = "";
  for (var i = 0; i < n; i++) {
    var v = i > 0 ? i : "";
    s = s + v + helper313();
  }
  return s;
}
print(reader(0), loopReader(2));
helper313 = function () { return "replaced"; };
print(reader(0), loopReader(2));
globalThis.helper313 = function () { return "viaGlobalThis"; };
print(reader(0), reader(1));
