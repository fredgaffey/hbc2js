// Corpus a03 (hbc98): an inlined helper whose returned closure creates a
// `then` that creates the closure again over an environment `then` owns.
// Per-creation-context copies would nest inside themselves; the closure
// must become a G2 factory (`hydrate` / `_fn7372__c1` were E_UNBOUND_IDENT).
(function () {
var toThenable = function (fn) {
  return function (input) {
    try {
      var result = fn(input);
      if (result instanceof Promise) return result;
      return {
        then: function (onFulfilled) { return toThenable(onFulfilled)(result); },
        catch: function (_onRejected) { return this; }
      };
    } catch (e) {
      return {
        then: function (_onFulfilled) { return this; },
        catch: function (onRejected) { return toThenable(onRejected)(e); }
      };
    }
  };
};
function hydrate(get) {
  var state;
  return toThenable(get)("k").then(function (v) { state = v + 1; return state; }).then(function (s) { print("got " + s); }).catch(function (e) { print("err " + e); });
}
hydrate(function (k) { return k + "!"; });
hydrate(function (k) { throw new Error("bad " + k); });
toThenable(function (x) { return x * 2; })(21).then(function (v) { print(v); });
})();
