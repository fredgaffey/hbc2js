"use strict";
function f(g) { var r = 1; try { r = g(); } catch (e) {} return r; }
function h(o) { try { o.x(); } catch (e) { return "no"; } return "yes"; }
function k(a) { var n = 0; for (var i = 0; i < a.length; i++) { try { n += a[i](); } catch (e) { n += 100; } } return n; }
print([f(function () { throw 1; }), f(function () { return 2; }), h({}), h({ x: function () {} }),
  k([function () { return 1; }, function () { throw 0; }])].join(","));
