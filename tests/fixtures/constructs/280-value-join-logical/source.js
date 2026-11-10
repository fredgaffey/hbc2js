// Value joins: a `||`/`&&`/`?:` whose result flows into an enclosing
// if/else join. Hermes keeps the inner expression's join block (it carries
// the expression's phi), so the bytecode has a jump-to-jump block an
// if-statement never leaves behind. Decompiled as a labelled block with a
// guard `break`, the recompile threads that block away and every later
// label shifts (round-trip buckets diff:JmpFalse(label)/diff:JmpTrue(label)).
function orInElse(f, p, q) { return f ? f(p.pathname, q) : p.pathname || ""; }
function andInElse(f, p, q) { return f ? f(p.name, q) : p.name && p.name.length; }
function condInElse(a, b, c, d, e) { return e ? (a - b.left >= 0 ? a - b.left : a) : (d ? a : c); }
function condNegated(a, b, c) { return a ? b.x : !(b.y < c) ? c : b.y; }
function strip(s, q) { return s + "/" + q; }
// Plain if-statements over the same values: no expression join, nothing to
// recover — these must keep recompiling identically too.
function ifOr(p) { var r = p.pathname; if (!r) r = ""; return r; }
function ifAnd(p, q) { var r = p.name; if (r) r = q; return r; }

var P = { pathname: "/a", name: "nm" }, E = { pathname: "", name: "" };
print(orInElse(0, P, 1), orInElse(0, E, 1));
print(andInElse(0, P, 1), andInElse(0, E, 1));
print(condInElse(5, { left: 2 }, 7, 0, 1), condInElse(1, { left: 2 }, 7, 0, 1), condInElse(1, {}, 7, 1, 0), condInElse(1, {}, 7, 0, 0));
print(condNegated(1, { x: 3 }, 0), condNegated(0, { y: 1 }, 2), condNegated(0, { y: 5 }, 2), condNegated(0, { y: NaN }, 2));
print(ifOr(P), ifOr(E), ifAnd(P, 4), ifAnd(E, 4));
print(orInElse(strip, P, 1), andInElse(strip, E, 2));
