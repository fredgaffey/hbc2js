// An exception thrown mid-argument-list: earlier args ran, later did not, callee never ran.
var log = [];
function s(x) { log.push("s" + x); return x; }
function boom(m) { log.push("boom " + m); throw new Error(m); }
var calls = 0;
var o = { get m() { log.push("get m"); return function () { calls++; }; } };
try { o.m(s(1), boom("a"), s(2)); } catch (e) { log.push("caught " + e.message); }
print(calls, log.join(" ")); log = [];
var x = 0;
try { x = s(1) + boom("b") + s(2); } catch (e) { log.push("caught " + e.message); }
print(x, log.join(" ")); log = [];
var arr = null;
try { arr = [s(3), boom("c"), s(4)]; } catch (e) { log.push("caught " + e.message); }
print(arr, log.join(" ")); log = [];
var t = {};
try { t[s("k")] = boom("d"); } catch (e) { log.push("caught " + e.message); }
print("k" in t, log.join(" ")); log = [];
try { new (function (a, b) { log.push("ctor"); })(s(5), boom("e")); } catch (e) { log.push("caught " + e.message); }
print(log.join(" "));
