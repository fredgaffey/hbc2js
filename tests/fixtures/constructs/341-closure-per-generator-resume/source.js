// review-1110 iife/private: a closure created after a `yield` inside a
// generator loop is a fresh object on every resumption. Before v97 the
// generator body is a step function re-entered through a resume switch, so
// the loop has no CFG cycle; the closure was hoisted into the factory and
// every `next()` yielded the same object.
function* h() { while (true) { var z = function () {}; yield z; } }
var hi = h();
print('loop distinct:', hi.next().value !== hi.next().value);
function* g() {
  var f = function () {};
  yield f;
  yield f;
  var a = [];
  for (var i = 0; i < 2; i++) { a.push(function () {}); yield 0; }
  yield a[0] !== a[1];
}
var it = g();
var x = it.next().value, y = it.next().value;
it.next(); it.next();
print('before-yield same:', x === y, 'after-yield distinct:', it.next().value);
