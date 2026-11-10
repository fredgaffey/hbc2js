// `Object.defineProperty(exports, "x", {enumerable: true, get: ...})` -- the
// re-export header Babel/Metro emit for every `export { x } from "..."`.
// Hermes loads `Object` and `Object.defineProperty` BEFORE it allocates the
// descriptor literal (source order), so the decompiled call must keep the
// literal inline in the argument list for the round trip to reproduce that
// order. docs/specs/passes/20-object-literal.md section 9.
// Shaped like a Metro module factory: `exports` is a parameter, so the
// call's other arguments are plain register reads.
function factory(exports, inner) {
  Object.defineProperty(exports, "a", {
    enumerable: true,
    get: function () { return inner.a; },
  });
  Object.defineProperty(exports, "b", {
    enumerable: true,
    get: function () { return inner.b; },
  });
}

function reexport(target, key, inner) {
  Object.defineProperty(target, key, {
    enumerable: true,
    get: function () { return inner[key]; },
  });
}

var exportsObj = {};
var source = { a: 1, b: 2 };
factory(exportsObj, source);
reexport(exportsObj, "c", source);
source.c = 3;

print(exportsObj.a, exportsObj.b, exportsObj.c, Object.keys(exportsObj).join(","));
