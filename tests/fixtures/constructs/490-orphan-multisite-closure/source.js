// A capture-free function created from several functions, in more than one
// Metro module (docs/BUGS.md 2026-11-24, cluster
// export:orphan-multisite-closure-not-emitted). hermesc inlines `isNumPred`
// and `all` into their callers, and every inlined copy carries its own
// CreateClosure of the one (capture-free) predicate function: sites in module
// 0's factory, in its nested `twice`, and in module 1's factory. With no
// single creation site the predicate is an orphan. The whole-file render
// hoists it to top level; each split/export module file must declare it.
var __hbc_registry = {};
var __hbc_cache = {};

function __d(factory, id, deps) {
  __hbc_registry[id] = { factory: factory, deps: deps };
}

function __r(id) {
  if (__hbc_cache[id]) return __hbc_cache[id].exports;
  var entry = __hbc_registry[id];
  var mod = { exports: {} };
  __hbc_cache[id] = mod;
  entry.factory(globalThis, __r, null, null, mod, mod.exports, entry.deps);
  return mod.exports;
}

(function () {
  "use strict";
  function isNumPred() {
    return function (x) { return typeof x === "number" && x === x; };
  }

  __d(function (global, require, importDefault, importAll, module, exports, dependencyMap) {
    "use strict";
    var all = function (arr) { return arr.every(isNumPred()); };
    exports.all = all;
    exports.twice = function (a, b) { return all(a) + ":" + all(b); };
    exports.atLoad = all([1, 2]) && !all([NaN]);
  }, 0, []);

  __d(function (global, require, importDefault, importAll, module, exports, dependencyMap) {
    "use strict";
    var m0 = require(dependencyMap[0]);
    exports.count = [1, "a", NaN, 4].filter(isNumPred()).length;
    exports.both = function (arr) { return m0.twice(arr, [3]) + ":" + m0.atLoad; };
  }, 1, [0]);
})();

var m1 = __r(1);
print(m1.count);
print(m1.both([1, 2]));
print(m1.both(["x", 3]));
