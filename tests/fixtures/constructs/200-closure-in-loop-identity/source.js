// review-1109-1: a closure created inside a loop of a function that owns no
// environment (it captures only its enclosing function's binding) must be a
// fresh function object on every iteration. The decompiler emits it as one
// hoisted function declaration, so every iteration pushes the same object.
function H(hv) {
  function C(n) {
    var fs = [];
    for (var i = 0; i < n; i++) fs.push(function () { return hv; });
    return fs;
  }
  return C;
}
var fs = H(5)(2);
print('distinct:', fs[0] !== fs[1]);
print('values:', fs[0](), fs[1]());
