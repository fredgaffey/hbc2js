"use strict";
function f(g) { var r = 1; try { r = g(); } catch (e) {} return r; }
function h(o) { try { o.x(); } catch (e) { return "no"; } return "yes"; }
print([f(function () { throw 1; }), f(function () { return 2; }), h({}), h({ x: function () {} })].join(","));
