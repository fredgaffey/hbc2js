// fix-closure-identity-2 (review-1110 iife/private): a named function
// expression created in a loop keeps its own name; a self-reference inside it
// is the function, and a same-named outer binding read inside an anonymous
// one is still the outer binding.
function mk() {
  var hs = [];
  for (var i = 0; i < 2; i++) {
    var f = function named() { return typeof named; };
    hs.push(f);
  }
  return hs;
}
var hs = mk();
print('name:', hs[0].name, hs[1].name, hs[0] !== hs[1], hs[0]());
function rec() {
  var out = [];
  for (var i = 0; i < 2; i++) out.push(function fact(n) { return n <= 1 ? 1 : n * fact(n - 1); });
  return out[0].name + ' ' + out[1](5) + ' ' + (out[0] !== out[1]);
}
print('rec:', rec());
function outerRef() {
  var res = [];
  for (var i = 0; i < 2; i++) {
    let probe = function () { return probe; };
    const g = probe;
    probe = i;
    res.push(g.name + ':' + g());
  }
  return res.join();
}
print('outer:', outerRef());
