// A program's own `HermesInternal` property, read off an object that is not
// the global object (export-boot apps, Expensify: @sentry/react-native reads
// `RN_GLOBAL_OBJ.HermesInternal.enablePromiseRejectionTracker`, where
// RN_GLOBAL_OBJ is a module value). Only hermesc's own template-literal
// lowering reads `HermesInternal` off the global object; every other read is
// an ordinary property read and must stay one.
(function () {
  "use strict";
  var host = {
    HermesInternal: {
      tag: "own",
      enablePromiseRejectionTracker: function (opts) { return "tracked:" + opts.allRejections; },
    },
  };
  function read(o) { return o.HermesInternal; }
  var own = read(host);
  var missing = read({});
  var tracker = own && own.enablePromiseRejectionTracker;
  print(`${own.tag} ${typeof missing} ${tracker ? tracker({ allRejections: true }) : "untracked"}`);
})();
