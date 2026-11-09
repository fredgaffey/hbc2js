// Negative twin of 140-define-property-getter: the descriptor literal here is
// built BEFORE the method is read, and building it is observable (a getter
// read, a global read through an accessor on the global object). Moving the
// literal into the call's argument slot would run those effects after the
// method read instead, so the decompiled output must keep it a separate
// statement. docs/specs/passes/20-object-literal.md section 9.
var log = [];
var api = {
  get m() {
    log.push("m");
    return function (t, k, d) { t[k] = d.value; };
  },
};
var src = {
  get v() { log.push("v"); return 1; },
};
Object.defineProperty(globalThis, "g", {
  configurable: true,
  get: function () { log.push("g"); return 2; },
});

function viaGetter(t) {
  var d = { enumerable: true, value: src.v };
  api.m(t, "a", d);
}
function viaGlobal(t) {
  var d = { enumerable: true, value: g };
  api.m(t, "b", d);
}

var target = {};
viaGetter(target);
viaGlobal(target);
print(log.join(","), target.a, target.b);
