// `f.apply(t, arguments)`: from v98 hermesc emits a JmpBuiltinIs diamond on
// Function.prototype.apply (fast path: the applyArguments builtin copies the
// caller's actual arguments; generic path: reify `arguments` and call
// `.apply`). Both arms must decompile to the one `f.apply(t, arguments)`; a
// shadowed `.apply` or an overridden Function.prototype.apply must still take
// the generic path.
function kind(a) {
  return typeof a === "function" ? "f" : typeof a === "object" ? "o" : String(a);
}
function show() {
  var out = [];
  for (var i = 0; i < arguments.length; i++) out.push(kind(arguments[i]));
  return "this=" + this.tag + " args=" + out.join(",");
}
function forward(f, t) {
  "use strict";
  return f.apply(t, arguments);
}
function forwardThis(f) {
  "use strict";
  var r = f.apply(this, arguments);
  return r + "!";
}
function forwardLoose(f, t) {
  return f.apply(t, arguments);
}
function forwardNoParams() {
  return show.apply(this, arguments);
}
var ctx = { tag: "T" };
print(forward(show, ctx, 1, 2));
print(forwardThis.call(ctx, show, 9));
print(forwardLoose(show, ctx));
print(forwardNoParams.call(ctx, 5, 6, 7));
// negative twin: `.apply` shadowed on the callee is the generic path
var fake = function () { return "real"; };
fake.apply = function (t, args) { return "shadowed " + t.tag + " " + args.length; };
print(forward(fake, ctx, 3));
// overriding Function.prototype.apply itself: still observed by every site
var saved = Function.prototype.apply;
Function.prototype.apply = function (t, args) { return "overridden " + typeof t + " " + args.length; };
print(forward(show, ctx, 1));
print(forwardLoose(show, ctx, 1, 2));
Function.prototype.apply = saved;
print(forward(show, ctx, 3, 4));
