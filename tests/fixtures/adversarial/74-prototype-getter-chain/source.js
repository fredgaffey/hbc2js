// Methods and data found via prototype accessors; this-binding and setter dispatch.
var log = [];
var base = {
  get greet() { log.push("get greet this.n=" + this.n); return function (x) { return "hi " + this.n + x; }; },
  set val(v) { log.push("proto set val " + v + " on " + this.n); this._v = v; },
  get val() { log.push("proto get val " + this.n); return this._v; },
};
var mid = Object.create(base); mid.n = "mid";
var leaf = Object.create(mid); leaf.n = "leaf";
print(leaf.greet("!"), log.join(" | ")); log = [];
leaf.val = 3;
print(leaf.hasOwnProperty("_v"), mid.hasOwnProperty("_v"), log.join(" | ")); log = [];
leaf.val += 4;
print(leaf._v, log.join(" | ")); log = [];
Object.setPrototypeOf(leaf, { get greet() { log.push("swapped"); return function () { return "yo"; }; } });
print(leaf.greet(), log.join(" | "));
