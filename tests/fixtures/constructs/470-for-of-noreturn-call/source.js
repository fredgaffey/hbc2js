// for-of noreturn-call fallthrough (docs/BUGS.md for-of-noreturn-handler-label,
// found by an export benchmark on a 39k-function bare RN app). Hermes proves
// `fail` never returns (it always throws and does not escape), so it emits
// nothing after the call inside the for-of body: the call's block falls
// straight through into the loop's `Catch; IteratorClose; Throw` cleanup.
// That fallthrough makes the cleanup a merge point, the structurer wraps the
// loop's `try` in a labeled block and prints the fallthrough as
// `break L<n>` -- and the for-of pass, which drops that wrapper, left the
// break pointing at a label that no longer existed (invalid JS).
var api = (function () {
  "use strict";
  function fail(msg) {
    throw new TypeError(`bad name: ${msg}`);
  }
  function addUnique(set, name) {
    set.has(name) && fail(`duplicate '${name}'`);
    set.add(name);
  }
  var has = Object.prototype.hasOwnProperty;
  var reservedA = { Object: 1 };
  var reservedB = { Map: 1 };
  function checkNames(list) {
    var seen = new Set();
    for (var item of list)
      typeof item === "string" &&
        ((has.call(reservedA, item) || has.call(reservedB, item)) && fail(`'${item}' is reserved`),
        addUnique(seen, item));
    return seen.size;
  }
  return { checkNames: checkNames };
})();
var out = [];
var lists = [["a", "bb", 3, "ccc"], ["x", "Map", "y"], [], ["Object"], ["q", null, "rr", "q"], ["k", "kk"]];
for (var i = 0; i < lists.length; i++) {
  try {
    out.push(String(api.checkNames(lists[i])));
  } catch (e) {
    out.push(e.constructor.name + ":" + e.message);
  }
}
print(out.join(","));
