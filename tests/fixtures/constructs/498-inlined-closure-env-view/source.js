"use strict";
var sink = {};
function M(seed) {
  function makeSetup(dep) {
    return function o(x) { sink.c = { f: function (...a) { return dep + x + a.length; }, g: function () { return x + dep; } }; };
  }
  var setup = makeSetup(seed);
  function init(v) {
    var s = setup;
    function h() { if (!sink.flag) s(v); }
    h();
    return h;
  }
  return init;
}
var init = M(5);
var h = init(3);
var out = [sink.c.f(1, 2), sink.c.g()];
sink.c = null; h();
out.push(sink.c.f(), sink.c.g());
var h2 = init(10); out.push(sink.c.f(1), sink.c.g());
h(); out.push(sink.c.g());
print(out.join(","));
