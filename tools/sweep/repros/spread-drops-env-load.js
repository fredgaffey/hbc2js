// sweep 2026-11-24, Ignite hbc96 fn#4028: an object spread followed by a
// property whose value reads a captured variable through the register that
// held the copyDataProperties result; the decompiled text drops the load.
function make(config) {
  var outputs = config.outputs;
  var base = { a: 1 };
  return config.inputs.map(function (x, i) {
    return wrap({ ...base, outputRange: outputs.map(function (y) { return y + i; }) });
  });
}
function wrap(o) { return o; }
var r = make({ inputs: [1, 2], outputs: [10, 20] });
print(JSON.stringify(r));
