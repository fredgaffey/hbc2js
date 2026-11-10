// Review 1110 (diamonds): adversarial probes for the v98+ `f.call` /
// `f.apply(t, arguments)` JmpBuiltinIs diamonds (fcall-diamond, R3g) --
// exotic callees, Function.prototype.call/apply deleted or overridden
// mid-function, getters on the callee read, receiver reassignment, nested
// diamonds, exception edges, and `arguments` mutated / escaping / aliased by
// parameters in loose and strict functions with simple and non-simple params.
function kind(a) {
  return typeof a === "function" ? "f" : typeof a === "object" ? (a === null ? "null" : "o") : String(a);
}
function show() {
  var out = [];
  for (var i = 0; i < arguments.length; i++) out.push(kind(arguments[i]));
  return "this=" + (this && this.tag) + " args=" + out.join(",");
}
function err(e) {
  return e instanceof TypeError ? "TypeError" : "other:" + e;
}
var ctx = { tag: "T" };
var ctx2 = { tag: "U" };

// --- call form ---------------------------------------------------------
function callIt(f, t, a, b) {
  return f.call(t, a, b);
}
function callZero(f) {
  return f.call();
}
var bound = show.bind(ctx2, "pre");
print("bound " + callIt(bound, ctx, 1, 2));
var prox = new Proxy(show, { apply: function (tg, th, args) { return "proxy " + (th && th.tag) + " " + args.length; } });
print("proxy " + callIt(prox, ctx, 1, 2));
try { print(callIt({}, ctx, 1, 2)); } catch (e) { print("nonfn " + err(e)); }
try { print(callIt(undefined, ctx, 1, 2)); } catch (e) { print("undef " + err(e)); }
print("zero " + callZero(show));

function callDeleteMid(f) {
  var saved = Function.prototype.call;
  var r = f.call(ctx, 1);
  delete Function.prototype.call;
  var s;
  try { s = f.call(ctx, 2); } catch (e) { s = "deleted " + err(e); }
  Function.prototype.call = function (t) { return "overridden " + (t && t.tag); };
  var u = f.call(ctx2, 3);
  Function.prototype.call = saved;
  var w = f.call(ctx2, 4);
  return [r, s, u, w].join(" | ");
}
print(callDeleteMid(show));

var reads = 0;
var holder = { get fn() { reads++; return show; } };
function callGetter(o) {
  return o.fn.call(ctx, reads);
}
print("getter " + callGetter(holder) + " reads=" + reads);
var callReads = 0;
var gfn = function () { return "gfn " + (this && this.tag); };
Object.defineProperty(gfn, "call", { get: function () { callReads++; return Function.prototype.call; } });
print(callIt(gfn, ctx, 0, 0) + " callReads=" + callReads);

function callReassign(f, g) {
  return f.call((f = g, ctx), 1) + " / " + f.call(ctx2);
}
print(callReassign(show, function () { return "g " + this.tag; }));

function callNested(f, g, h) {
  return f.call(ctx, g.call(ctx2, 1), h.call(null, g.call(ctx, 2, 3)));
}
print("nested " + callNested(show, show, show));

function boom() { throw new Error("boom"); }
function callThrows(f, n) {
  var r = "init";
  try {
    r = f.call(ctx, n > 0 ? boom() : n, 7, 8, 9, 10);
  } catch (e) {
    r = r + " caught " + e.message;
  }
  return r;
}
print(callThrows(show, 0));
print(callThrows(show, 1));
print(callThrows(boom, 0));

function callInLoop(fs) {
  var out = [];
  for (var i = 0; i < fs.length; i++) {
    try { out.push(fs[i].call(ctx, i)); } catch (e) { out.push(err(e)); }
    if (i === 1) Function.prototype.call = function () { return "ovl"; };
  }
  return out.join(";");
}
var savedCall = Function.prototype.call;
print(callInLoop([show, show, show, 5]));
Function.prototype.call = savedCall;

// --- apply form --------------------------------------------------------
function looseReassign(f, t) {
  f = show;
  t = ctx2;
  return f.apply(t, arguments);
}
print("looseReassign " + looseReassign(function () { return "orig"; }, ctx, 1));
function strictReassign(f, t) {
  "use strict";
  f = show;
  t = ctx2;
  return f.apply(t, arguments);
}
print("strictReassign " + strictReassign(function () { return "orig"; }, ctx, 1));
function looseDefault(f, t = ctx) {
  t = ctx2;
  return f.apply(t, arguments);
}
print("looseDefault " + looseDefault(show));
print("looseDefault2 " + looseDefault(show, ctx, 9));
function looseMutate(f, t) {
  arguments[2] = 42;
  return f.apply(t, arguments);
}
print("looseMutate " + looseMutate(show, ctx, 1));
function strictMutate(f, t) {
  "use strict";
  arguments[2] = show;
  return f.apply(t, arguments);
}
print("strictMutate " + strictMutate(show, ctx, 1));
function looseLength(f, t) {
  arguments.length = 1;
  return f.apply(t, arguments);
}
print("looseLength " + looseLength(show, ctx, 1, 2));
function looseLengthRest(f, t, ...rest) {
  arguments.length = 5;
  return f.apply(t, arguments) + " rest=" + rest.length;
}
print("looseLengthRest " + looseLengthRest(show, ctx, 1));
function escapeArrow(f, t) {
  var get = () => arguments;
  var r = f.apply(t, arguments);
  get()[0] = 1;
  return r + " " + kind(arguments[0]);
}
print("escapeArrow " + escapeArrow(show, ctx, null));
function escapeClosureFirst(f, t) {
  var a = arguments;
  var mut = function () { a[2] = 99; a.length = 3; };
  mut();
  return f.apply(t, arguments);
}
print("escapeClosureFirst " + escapeClosureFirst(show, ctx, 1, 2, 3));
function twice(f, t) {
  return f.apply(t, arguments) + " & " + f.apply(ctx2, arguments);
}
print("twice " + twice(show, ctx, 1));
function selfApply() {
  return arguments[0].apply(this, arguments);
}
print("selfApply " + selfApply.call(ctx, show, 2));
function applyDeleteMid(f, t) {
  "use strict";
  var saved = Function.prototype.apply;
  delete Function.prototype.apply;
  try {
    return f.apply(t, arguments);
  } catch (e) {
    return "deleted " + err(e);
  } finally {
    Function.prototype.apply = saved;
  }
}
print("applyDeleteMid " + applyDeleteMid(show, ctx, 1));
function applyExotic(f, t) {
  "use strict";
  try { return f.apply(t, arguments); } catch (e) { return err(e); }
}
print("applyBound " + applyExotic(bound, ctx, 1));
print("applyProxy " + applyExotic(prox, ctx, 1, 2, 3));
print("applyNonFn " + applyExotic({}, ctx));
print("applyObjWithApply " + applyExotic({ apply: function (t, a) { return "own " + a.length; } }, ctx, 1));
function applyLooseExotic(f, t) {
  try { return f.apply(t, arguments); } catch (e) { return err(e); }
}
print("looseNonFn " + applyLooseExotic(5, ctx));
print("loosePrimThis " + applyLooseExotic(function () { return typeof this; }, 3));
print("strictPrimThis " + applyExotic(function () { "use strict"; return typeof this; }, 3));
function applyNested(f, t) {
  "use strict";
  return f.apply(t, arguments) + " " + (function (g) { return g.apply(ctx2, arguments); })(show, 7);
}
print("applyNested " + applyNested(show, ctx, 1));
function applyLoop(f, t) {
  var out = "";
  for (var i = 0; i < 2; i++) {
    out += f.apply(t, arguments) + ";";
    if (i === 0) Function.prototype.apply = function () { return "ovl" + arguments.length; };
  }
  return out;
}
var savedApply = Function.prototype.apply;
print("applyLoop " + applyLoop(show, ctx, 1));
Function.prototype.apply = savedApply;
function applyGetter(o) {
  "use strict";
  return o.fn.apply(ctx, arguments);
}
print("applyGetter " + applyGetter(holder, 3) + " reads=" + reads);
