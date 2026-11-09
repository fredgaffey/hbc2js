// The callee and receiver are fixed before arguments run, even if args reassign them.
var log = [];
var o = { id: "first", m: function (x) { return this.id + ":" + x; } };
var keep = o;
print(o.m((o = { id: "second", m: function () { return "wrong"; } }, "arg")));
print(o.id, keep.id);
var f = function (x) { return "f" + x; };
print(f((f = function () { return "g"; }, 1)), f(2));
var obj = { n: 1, get m() { log.push("get m n=" + this.n); var self = this; return function (v) { return self.n + v; }; } };
print(obj.m(obj.n = 10), log.join(" ")); log = [];
var arr = [function (a) { return "a0" + a; }, function (a) { return "a1" + a; }];
var idx = 0;
print(arr[idx](idx++), arr[idx](idx = 0));
var holder = { fn: function () { return this === holder; } };
print(holder.fn((holder.fn = null, 0)), holder.fn);
