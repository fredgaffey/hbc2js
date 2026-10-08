var __DEV__ = false;

__d(function (global, require, importDefault, importAll, module, exports, dependencyMap) {
  "use strict";
  var one = require(dependencyMap[0]);
  var two = require(dependencyMap[1]);
  module.exports = { one: one, two: two };
}, 0, [1, 2]);

// module 1 — dependencyMap[0] (=9) is never registered.
__d(function (global, require, importDefault, importAll, module, exports, dependencyMap) {
  "use strict";
  var missing = require(dependencyMap[0]);
  module.exports = missing;
}, 1, [9]);

// module 2 — registered once here...
__d(function (global, require, importDefault, importAll, module, exports, dependencyMap) {
  "use strict";
  module.exports = { tag: "first" };
}, 2, []);

// module 3 — reads an un-declared, non-allow-listed free global.
__d(function (global, require, importDefault, importAll, module, exports, dependencyMap) {
  "use strict";
  module.exports = someHostGlobal.value;
}, 3, []);

// module 4 — registerAsset names a file this fixture's assets/ dir does not
// have (only exists-icon.png is present).
__d(function (global, require, importDefault, importAll, module, exports, dependencyMap) {
  "use strict";
  module.exports = require(dependencyMap[0]).registerAsset({
    httpServerLocation: "assets",
    scales: [1],
    hash: "def456",
    name: "missing-icon",
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

// module 2 — ...and registered a second time here (duplicate id).
__d(function (global, require, importDefault, importAll, module, exports, dependencyMap) {
  "use strict";
  module.exports = { tag: "second" };
}, 2, []);

__r(0);
