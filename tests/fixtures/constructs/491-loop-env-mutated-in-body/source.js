// A per-iteration loop binding that the body also writes after a branch,
// in the shape Babel lowers `for (let c ...) { fs.push(() => c); if (c === 3)
// c++; }` to: a `_loop(c)` helper that hermesc v98/v99 inlines into the loop,
// keeping its own environment created once per iteration (torture hbc99
// "per-iteration let closure capture, loop var mutated in body").
//
// The decompiler declared that environment's slot function-wide because one
// write sat outside the creating basic block, so every closure shared it; and
// even a block-scoped `let` is one binding per activation under Hermes, which
// compiles without ES6 block scoping. Expected: each closure keeps its own
// iteration's value, the fourth one the value after the in-body increment.
function scan(x) {
  var h = x | 0;
  var fs = [];
  var _loop = function _loop(_c) {
    fs.push(function () { return _c * (h & 7) + _c; });
    if (_c === 3) _c++;
    c = _c;
  };
  for (var c = 0; c < 5; c++) {
    _loop(c);
  }
  var gs = [];
  var _loop2 = function _loop2(i, j) {
    gs.push(function () { return i * 100 + j; });
  };
  for (var i = 0, j = 10; i < 3; i++, j--) {
    _loop2(i, j);
  }
  return fs.map(function (f) { return f(); }).join(",") + " " + gs.map(function (g) { return g(); }).join(",");
}
print(scan(3));
print(scan(12));
