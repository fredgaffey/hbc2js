// A function with its OWN captured environment plus one inlined IIFE.
//
// Round-trip review "passes-roundtrip-bucket": `hermesc -O` inlines the
// namespace-interop helper below into the caller, keeping the helper's own
// environment, so the caller creates two sibling environments: its own
// (`a`, `b`, `w`, read by the returned getters) and the helper's (`e`, `n`,
// read by the forEach callback and its `get`). Spec 27 wrapped neither: the
// caller's own environment was a candidate too, and its statements straddle
// the helper's, so both refused as `overlapping statement ranges`. The
// recompile then had one merged environment (the
// `diff:CreateFunctionEnvironment(imm)` / `diff:LoadFromEnvironment(imm)`
// buckets).
function makeModule(req, deps) {
  "use strict";
  var a = req(deps[0]);
  var w = (function (e) {
    if (e && e.__esModule) return e;
    var n = {};
    if (e) Object.keys(e).forEach(function (k) {
      var t = Object.getOwnPropertyDescriptor(e, k);
      Object.defineProperty(n, k, t.get ? t : { enumerable: true, get: function () { return e[k]; } });
    });
    n.default = e;
    return n;
  })(req(deps[1]));
  var b = req(deps[2]);
  return {
    getA: function () { return a.x; },
    getW: function () { return w.default.y + w.y; },
    getB: function () { return b; },
  };
}

var mods = [{ x: 1 }, { y: 20 }, "three", { __esModule: true, y: 5, default: { y: 7 } }];
function req(i) { return mods[i]; }
var m = makeModule(req, [0, 1, 2]);
print(m.getA());
print(m.getW());
print(m.getB());
var m2 = makeModule(req, [0, 3, 2]);
print(m2.getW());
