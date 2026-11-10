// A store into a key the fresh object literal already owns, sitting inside a
// sequence expression (a conditional's or a call argument's value), folds
// back into the literal: `(o = {k: null}, o.k = v, o)` -> `{k: v}`.
// Hermes compiles `{enumerable: true, get: function () {...}}` and
// `{scales: [1], ...}` to NewObjectWithBuffer with a placeholder plus a
// PutOwnBySlotIdx; printing the fill as `o.k = v` recompiles to a PutById.
// The fold is sound for ANY store opcode: `[[Set]]` on an own writable data
// property is a plain value update and never reaches the prototype chain.
// docs/specs/passes/20-object-literal.md section 9 (kind C).
function exportStar(target, source) {
  Object.keys(source).forEach(function (key) {
    var d = Object.getOwnPropertyDescriptor(source, key);
    Object.defineProperty(target, key, d.get ? d : {
      enumerable: true,
      get: function () { return source[key]; },
    });
  });
}

// Shaped like a Metro asset module factory.
function asset(global, require, importDefault, importAll, module, exports, deps) {
  module.exports = require(deps[0]).register({
    packaged: true,
    location: "/assets/a",
    width: 32,
    scales: [1],
    hash: "abc",
    fileHashes: ["abc"],
  });
}

var out = {};
var src = { a: 1, b: 2 };
Object.defineProperty(src, "c", { enumerable: true, get: function () { return 3; } });
exportStar(out, src);
src.a = 10;
var mod = {};
asset(undefined, function () { return { register: function (o) { return o; } }; }, null, null, mod, null, [0]);
var seen = mod.exports;
print(out.a, out.b, out.c, Object.keys(out).join(","), seen.scales.join(","), seen.fileHashes[0], Object.keys(seen).join(","));
