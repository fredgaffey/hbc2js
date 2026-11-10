// A closure passed as an argument, captured by an inner getter and called
// there (export-boot L4, react-navigation module 991 fn#11865 "get"). With a
// single call site hermesc inlines both helpers, then inlines the call to the
// known closure inside the getter: it loads the closure back out of the
// getter's environment slot and reads the callee's captured variables through
// GetClosureEnvironment (and GetEnvironment from there to its parent scope).
(function () {
  "use strict";
  var log = [];
  function lazy(obj, key, getter) {
    var done = false;
    var value;
    Object.defineProperty(obj, key, {
      get: function get() {
        if (!done) {
          done = true;
          value = getter();
        }
        return value;
      },
      configurable: true,
      enumerable: true,
    });
  }
  function wire(exp, name, make) {
    var calls = 0;
    {
      let tag = name + "#";
      lazy(exp, name, function get() {
        calls++;
        log.push(tag + calls);
        return make(name + ":" + calls);
      });
    }
  }
  var exp = {};
  wire(exp, "alpha", function (s) { return s.toUpperCase(); });
  print(exp.alpha, exp.alpha, Object.keys(exp).join(","));
  print(log.join(" "));
})();
