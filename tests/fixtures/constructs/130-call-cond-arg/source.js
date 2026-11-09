// A method call whose argument list holds a conditional: hermesc reads the
// method (GetById) BEFORE evaluating the arguments, so the decompiled form
// separates the read from the call by the argument's control flow.
var log = [];
function trace(name, value) {
  return {
    get m() { log.push("read " + name + ".m"); return function (a, b, c) { log.push("call " + name); return [this === obj, a, b, c].join("|"); }; },
  };
}
var obj = trace("obj");

function pick(o, t, n, d) { return o.m(t, n, d.get ? d : { enumerable: true }); }
function twoConds(o, c, d) { return o.m(c ? 1 : 2, d ? 3 : 4); }
function reassign(o, c) { var p = o; return p.m(c ? (p = 7, 1) : 2, p); }
function viaGlobal(t, n, d) { return Object.keys(d.get ? d : { x: t, y: n }).length; }

var desc = { get get() { log.push("read d.get"); return 0; } };
print(pick(obj, "t", "n", desc));
print(pick(obj, "t", "n", { get: 1 }));
print(twoConds(obj, true, false), twoConds(obj, 0, 1));
print(reassign(obj, true), reassign(obj, false));
print(viaGlobal(1, 2, {}), viaGlobal(1, 2, { get: 1, a: 2 }));
print(log.join(","));

// The namespace-interop helper every `import * as` module inlines.
var src = { a: 1, get b() { return 2; } };
var ns = (function (e) {
  if (e && e.__esModule) return e;
  var t = {};
  return e && Object.keys(e).forEach(function (n) {
    var o = Object.getOwnPropertyDescriptor(e, n);
    Object.defineProperty(t, n, o.get ? o : { enumerable: true, get: function () { return e[n]; } });
  }), t.default = e, t;
})(src);
print(ns.a, ns.b, ns.default === src, Object.keys(ns).join(","));
