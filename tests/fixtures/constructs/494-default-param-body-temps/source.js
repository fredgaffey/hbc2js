// Sweep 2026-11-24 S4 (default-params), q7 hbc99 fn#20119: a sloppy-mode default
// parameter with a multi-step initialiser. default-params runs from the parent
// function, after var-naming renamed the prologue registers, and declared only
// names still shaped `rN` inside the default IIFE: the renamed temporaries
// stayed body `let`s, invisible from the parameter scope, so the default
// assigned globals (DIVERGENT v84-v99). Sweep repro, unchanged.
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
