// Getters on receiver AND in arguments; method read must precede argument reads.
var log = [];
function g(name, val) { var o = {}; Object.defineProperty(o, "v", { get: function () { log.push(name); return val; } }); return o; }
var api = { get run() { log.push("run"); return function () { return Array.prototype.join.call(arguments, ","); }; } };
var x = g("x", 1), y = g("y", 2);
var r1 = api.run(x.v, y.v, { k: x.v }, [y.v]);
print(r1, log.join(" ")); log = [];
var r2 = api.run(api.run(x.v), y.v);
print(r2, log.join(" ")); log = [];
var holder = { get api() { log.push("holder.api"); return api; } };
var r3 = holder.api.run(holder.api && x.v);
print(r3, log.join(" ")); log = [];
var r4 = api.run.call(null, y.v, x.v);
print(r4, log.join(" "));
