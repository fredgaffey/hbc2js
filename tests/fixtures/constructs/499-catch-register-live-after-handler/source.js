"use strict";
function f(g) { var x = 0; try { x = g(); } catch (e) { x = e; } return x; }
function k(g, n) { var x; try { x = g(n); } catch (e) { x = e; } return typeof x === "string" ? "caught:" + x : x; }
var out = [];
out.push(f(function () { throw "boom"; }), f(function () { return 4; }));
out.push(k(function (n) { if (n > 1) throw "big"; return n; }, 2), k(function (n) { return n; }, 1));
print(out.join(","));
