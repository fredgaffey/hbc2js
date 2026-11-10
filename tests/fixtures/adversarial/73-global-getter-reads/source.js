// Globals defined as accessors: reads/writes observable, interleaved with locals.
var log = [];
var gval = 1;
Object.defineProperty(globalThis, "G", {
  get: function () { log.push("get G=" + gval); return gval; },
  set: function (v) { log.push("set G=" + v); gval = v; },
  configurable: true,
});
function s(x) { log.push("s" + x); return x; }
var r = G + s(10) + G;
print(r, log.join(" ")); log = [];
G = s(5) + G;
print(gval, log.join(" ")); log = [];
G += s(1);
print(gval, log.join(" ")); log = [];
G++;
print(gval, log.join(" ")); log = [];
var t = typeof G, u = typeof NOPE_UNDECLARED;
print(t, u, log.join(" ")); log = [];
function readTwice() { var a = G; gval = 100; return a + G; }
print(readTwice(), log.join(" "));
