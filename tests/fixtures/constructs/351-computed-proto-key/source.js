// adversarial-1110 (adversarial 79-object-literal-order): a computed
// `["__proto__"]: v` key in an object literal DEFINES an own property named
// "__proto__" (PutOwnByVal); it must not run the Object.prototype.__proto__
// setter. The emitter lowered PutOwnByVal to `o[k] = v`, which did.
var o3 = { __proto__: { inh: 1 }, ["__proto__"]: 5 };
print(o3.inh, Object.keys(o3).join(","), Object.getOwnPropertyDescriptor(o3, "__proto__").value);
var p = { ["__proto__"]: { fake: true }, z: 2 };
print(Object.getPrototypeOf(p) === Object.prototype, p.fake, JSON.stringify(Object.getOwnPropertyDescriptor(p, "__proto__")));
