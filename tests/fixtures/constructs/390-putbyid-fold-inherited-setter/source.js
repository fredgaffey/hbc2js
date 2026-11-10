// docs/BUGS.md 2026-11-10 "object-literal folds a PutById past an inherited
// setter": `o = {a: 1}; o.extra = 2` compiles to NewObjectWithBuffer +
// PutByIdLoose, a full [[Set]] that runs the setter Object.prototype carries
// for `extra`. The object-literal rung folds it into `{a: 1, extra: 2}` (an
// own define, no setter call) because nothing in the RUN could have changed
// Object.prototype -- but code that ran before the object existed did.
var log = [];
Object.defineProperty(Object.prototype, "extra", {
  configurable: true,
  set: function (v) { log.push("proto-set " + v); },
  get: function () { return "inherited"; },
});
function make() {
  var o = { a: 1 };
  o.extra = 2;
  return o;
}
var r = make();
delete Object.prototype.extra;
print(log.join(";"), r.a, Object.keys(r).join(","));
