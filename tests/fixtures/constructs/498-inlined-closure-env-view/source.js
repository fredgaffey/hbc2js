"use strict";
function M(seed) {
  function makeSetup(dep) {
    return function o(x) { globalThis.c = { f: function (...a) { return dep + x + a.length; }, g: function () { return x + dep; } }; };
  }
  var setup = makeSetup(seed);
  function init(v) {
    var s = setup;
    function h() { if (!globalThis.flag) s(v); }
    h();
    return h;
  }
  return init;
}
var init = M(5);
var h = init(3);
var out = [globalThis.c.f(1, 2), globalThis.c.g()];
globalThis.c = null; h();
out.push(globalThis.c.f(), globalThis.c.g());
var h2 = init(10); out.push(globalThis.c.f(1), globalThis.c.g());
h(); out.push(globalThis.c.g());
print(out.join(","));
