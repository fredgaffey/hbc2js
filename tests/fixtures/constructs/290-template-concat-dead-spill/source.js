// 290: a template literal in a branch, or two in sibling branches sharing one
// hoisted `HermesInternal.concat` read (roundtrip `diff:TryGetById(reg)`
// bucket, 2026-11-10). The template-literal rung folds every call, but the
// callee spill `concat = __hbc_HermesInternal.concat` it fed stayed behind as
// a dead store, which recompiles to a live TryGetById + GetById pair.
function msg(name, flag) {
  var s = "x";
  if (flag) { s = `${name}?`; }
  return s;
}
function pick(a, b, c) {
  return c ? `${a} in <${b}>` : `${b} and ${a}`;
}
function plural(n, few) {
  var o = {one: "one item", other: null};
  if (n > 1) o.other = few ? `${n} few` : `${n} items`;
  return o;
}
// negative twin 1: a user getter named `concat` read into an unused local
// is an observable effect and must survive.
var hits = 0;
var holder = { get concat() { hits++; return 1; } };
function touch(o) {
  var c = o.concat;
  return 7;
}
// negative twin 2: a template whose substitution throws -- the read order of
// the substitution against the concat is unchanged.
function boom(o) {
  if (o) return `v=${o.x.y}`;
  return "none";
}
print(msg("a", true), msg("b", false));
print(pick(1, 2, 0), pick(1, 2, 3));
print(plural(3, true).other, plural(3, false).other, plural(1, true).other);
print(touch(holder), hits);
try { boom({}); } catch (e) { print(e instanceof TypeError); }
print(boom(null), boom({ x: { y: 4 } }));
