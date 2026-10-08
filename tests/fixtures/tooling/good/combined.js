var __BUNDLE_START_TIME__ = Date.now();
var __DEV__ = false;
var modules = new Map();
function __d(factory, moduleId, dependencyMap) {
  modules.set(moduleId, { factory: factory, dependencyMap: dependencyMap });
}
function __r(moduleId) {
  var mod = modules.get(moduleId);
  if (!mod.publicModule) {
    mod.publicModule = { exports: {} };
    mod.factory(global, __r, undefined, undefined, mod.publicModule, mod.publicModule.exports, mod.dependencyMap);
  }
  return mod.publicModule.exports;
}

// module 0 — entry point, requires 1 and 2.
__d(function (global, require, importDefault, importAll, module, exports, dependencyMap) {
  "use strict";
  var one = require(dependencyMap[0]);
  var two = require(dependencyMap[1]);
  module.exports = { one: one, two: two };
}, 0, [1, 2]);

// module 1 — requires 3.
__d(function (global, require, importDefault, importAll, module, exports, dependencyMap) {
  "use strict";
  var three = require(dependencyMap[0]);
  module.exports = three;
}, 1, [3]);

// module 2 — requires 3, reads __DEV__ and console (both allow-listed).
__d(function (global, require, importDefault, importAll, module, exports, dependencyMap) {
  "use strict";
  var three = require(dependencyMap[0]);
  if (__DEV__) {
    console.log("module 2 loaded", three);
  }
  module.exports = three;
}, 2, [3]);

// module 3 — leaf; reads `global` and `nativeModuleProxy` (allow-listed).
__d(function (global, require, importDefault, importAll, module, exports, dependencyMap) {
  "use strict";
  var proxy = global.nativeModuleProxy;
  var local = 1;
  module.exports = { proxy: proxy, local: local };
}, 3, []);

// module 4 — asset module; registerAsset resolves under the fixture's own
// `assets/` directory (this fixture's own convention: httpServerLocation is
// a plain relative folder from the tree root, not a dev-server URL — see
// src/tooling/check-bundle.ts's module doc comment).
__d(function (global, require, importDefault, importAll, module, exports, dependencyMap) {
  "use strict";
  module.exports = require(dependencyMap[0]).registerAsset({
    httpServerLocation: "assets",
    scales: [1],
    hash: "abc123",
    name: "logo",
    type: "png",
  });
}, 4, [5]);

// module 5 — the asset registry module.
__d(function (global, require, importDefault, importAll, module, exports, dependencyMap) {
  "use strict";
  function registerAsset(asset) {
    return 1;
  }
  module.exports = { registerAsset: registerAsset };
}, 5, []);

__r(0);
