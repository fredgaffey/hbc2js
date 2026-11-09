// Negative twin of 120-own-env-plus-iife: the inlined helper's closure ALSO
// reads a variable of the caller's own environment (`tag`), so the closure
// spans two of the caller's environments and spec 27 must keep refusing it
// (`closure spans two environments`): a wrapper could live in only one scope.
function makeModule(req, deps) {
  "use strict";
  var tag = req(deps[0]);
  var w = (function (e) {
    var n = {};
    Object.keys(e).forEach(function (k) {
      Object.defineProperty(n, k, { enumerable: true, get: function () { return e[k] + tag.x; } });
    });
    return n;
  })(req(deps[1]));
  return {
    getTag: function () { return tag.x; },
    getW: function () { return w.y; },
  };
}

var mods = [{ x: 1 }, { y: 20 }];
function req(i) { return mods[i]; }
var m = makeModule(req, [0, 1]);
print(m.getTag());
print(m.getW());
