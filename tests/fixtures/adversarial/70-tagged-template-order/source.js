// Tagged templates: tag read first, then substitutions; strings array identity per site.
var log = [];
function s(x) { log.push("s" + x); return x; }
var seen = [];
var ns = {
  get tag() {
    log.push("get tag");
    return function (strs) { seen.push(strs); return strs.raw.join("|") + "#" + Array.prototype.slice.call(arguments, 1).join(","); };
  },
};
var r1 = ns.tag`a${s(1)}b\n${s(2)}c`;
print(r1, log.join(" ")); log = [];
function site() { return ns.tag`x${s(3)}y`; }
site(); site();
print(seen[1] === seen[2], seen[0] === seen[1], Object.isFrozen(seen[1]), log.join(" ")); log = [];
var obj = { m: function (st) { return this === obj; } };
print(obj.m`t`, (0, obj.m)`t`);
