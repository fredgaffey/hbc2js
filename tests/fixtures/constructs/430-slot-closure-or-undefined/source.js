// A captured variable that is either undefined or one known closure, called
// through optional call from a sibling closure (export-boot env markers,
// react-navigation module 1565 fn#13120 "O" / #13126 "continue", the
// react-query retryer's `continueFn`). hermesc v98+ inlines the call: it
// loads the slot, guards null/undefined and typeof, then reads the callee's
// captures through GetClosureEnvironment. The slot is also stored undefined,
// which is not a closure, so it cannot be what GetClosureEnvironment sees.
(function () {
  "use strict";
  var log = [];
  function makeRetryer(limit) {
    var failures = 0;
    var continueFn;
    var state = { status: "pending" };
    function pause(tag) {
      {
        let seen = tag + "!";
        continueFn = function (value) {
          if (state.status === "pending" || failures > limit) {
            log.push(seen + value + ":" + failures);
          }
        };
      }
    }
    function reset() {
      continueFn = undefined;
    }
    return {
      fail: function () { failures++; pause("p" + failures); },
      reset: reset,
      cont: function () { continueFn?.(failures * 10); return state.status; },
      done: function () { state.status = "done"; },
    };
  }
  var r = makeRetryer(1);
  r.cont();
  r.fail();
  r.cont();
  r.fail();
  r.done();
  r.cont();
  r.reset();
  r.cont();
  print(log.join(" "));
})();
