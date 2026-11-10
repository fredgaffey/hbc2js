// review-1110 iife/private negative control: a base constructor that returns
// a foreign object makes the derived class stamp its private field onto that
// object; a second stamp throws. Static private fields and methods, and a
// brand check on the subclass constructor, behave as in the VM.
class Base { constructor(o) { return o; } }
class Stamp extends Base {
  #x = 7;
  constructor(o) { super(o); }
  static has(o) { return #x in o; }
  static get(o) { return o.#x; }
}
var obj = {};
new Stamp(obj);
print('stamped:', Stamp.has(obj), Stamp.get(obj), Object.keys(obj).length, JSON.stringify(obj));
try { new Stamp(obj); print('twice: no throw'); } catch (e) { print('twice threw:', e instanceof TypeError); }
class S {
  static #count = 0;
  static #inc() { return ++S.#count; }
  static bump() { return S.#inc(); }
  static isS(o) { return #count in o; }
}
class Sub extends S {}
print('static:', S.bump(), S.bump(), S.isS(S), S.isS({}), S.isS(Sub));
