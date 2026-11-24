// sweep 2026-11-24, BlueWallet hbc99 fn#20119: a sloppy-mode default
// parameter with a multi-step initialiser, captured by a closure; the folded
// `(a1, r2 = (T = ..., arr2 = [T], arr2))` assigns names that are declared in
// the body, so in sloppy code they leak to the global object (and in strict
// code would throw).
var deps = [0, 1];
function req(i) { return { Transaction: { SIGHASH_ALL: i + 1 } }; }
var obj = {
  value: function (input, sighashTypes = [req(deps[1]).Transaction.SIGHASH_ALL]) {
    var self = this;
    return new Promise(function (res) { res(self.tag + input + ":" + sighashTypes.join("/")); });
  },
  tag: "T",
};
obj.value("a").then(function (v) { print(v); print(typeof globalThis.SIGHASH_ALL + " " + typeof globalThis.arr2); });
