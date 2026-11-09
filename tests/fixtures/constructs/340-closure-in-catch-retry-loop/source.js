// review-1110 iife/private: a closure created in a retry loop whose only back
// edge runs through a `catch` is a fresh function object on every attempt.
// The normal CFG has no cycle through the creation site (the attempt that
// loops leaves the `try` by an exception edge), so the decompiler hoisted it
// as one declaration and every attempt pushed the same object.
function H(n) {
  var fs = [];
  function boom(k) { if (k < n) throw k; }
  for (var k = 0; ; k++) {
    try { var f = function () { return k; }; fs.push(f); boom(k); break; } catch (e) {}
  }
  return fs;
}
var r = H(3);
print('attempts:', r.length, r[0] !== r[1], r[1] !== r[2]);
var wm = new WeakMap();
r.forEach(function (f, j) { wm.set(f, j); });
print('weakmap:', wm.get(r[0]), wm.get(r[1]), wm.get(r[2]));
var gs = [], i = 0;
while (true) {
  try { gs.push(function () { return 1; }); if (i++ < 1) throw 0; } catch (e) { continue; }
  break;
}
print('throw-continue:', gs.length, gs[0] !== gs[1]);
