// Negative twin of 260: a store inside a sequence expression that must NOT
// fold into the literal. `p.k = 1` names a key the literal owns as an
// ACCESSOR, so the store calls the literal's own setter; folding it as a
// data property would drop the call and replace the accessor.
// docs/specs/passes/20-object-literal.md section 9 (kind C refusals).
var log = [];
function use(t, x) { return x; }

function viaOwnSetter(d) {
  var p;
  return use(Object, d.get ? d : (p = { set k(v) { log.push("own-set " + v); }, get k() { return "own"; } }, p.k = 1, p));
}

var r = viaOwnSetter({});
print(log.join(";"), r.k, Object.keys(r).join(","), typeof Object.getOwnPropertyDescriptor(r, "k").set);
