// review-1110 iife/private: reading or writing a private field the object
// does not own throws a TypeError (Hermes JSObject::getPrivateField /
// setPrivateField: own lookup only, no prototype chain); a primitive base
// throws too. The symbol lowering `obj[sym]` read undefined (or the
// prototype's field) and the write created a new property.
class P {
  #x = 1;
  static get(o) { return o.#x; }
  static set(o, v) { o.#x = v; }
  static has(o) { return #x in o; }
}
var p = new P();
function attempt(label, f) {
  try { print(label, 'ok', f()); } catch (e) { print(label, 'threw', e instanceof TypeError); }
}
attempt('own get:', function () { return P.get(p); });
attempt('own set:', function () { P.set(p, 2); return P.get(p); });
attempt('foreign get:', function () { return P.get({}); });
var foreign = {};
attempt('foreign set:', function () { P.set(foreign, 3); return Object.getOwnPropertySymbols(foreign).length; });
attempt('after foreign set:', function () { return P.has(foreign); });
attempt('primitive get:', function () { return P.get(3); });
attempt('primitive set:', function () { P.set('s', 1); return 'none'; });
var child = Object.create(p);
attempt('proto get:', function () { return P.get(child); });
attempt('proto set:', function () { P.set(child, 9); return P.get(p); });
function outer() {
  class C { #a = 'outer'; static read(o) { return o.#a; }
    static inner() { class C { #a = 'inner'; static read(o) { return o.#a; } } return C; } }
  var I = C.inner();
  attempt('same-name nested:', function () { return C.read(new I()); });
  return [C.read(new C()), I.read(new I())].join();
}
print('nested own:', outer());
