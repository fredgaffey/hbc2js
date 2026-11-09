// Negative twin of 150: the same nested function is created in TWO functions.
//
// `hermesc -O` inlines `wrap` into both `left` and `right`, so the callback
// (closure environment `makeTwo`'s, it reads `tag`) has creation sites in two
// functions. No single function can host it; it stays in `makeTwo`, beside
// `left` and `right`.
function makeTwo(tag) {
  "use strict";
  function wrap(xs) {
    return xs.map(function (x) { return tag + x; });
  }
  function left(xs) { return wrap(xs).join("<"); }
  function right(xs) { return wrap(xs).join(">"); }
  return [left, right];
}
var lr = makeTwo("@");
print(lr[0](["a", "b"]));
print(lr[1](["c", "d"]));
