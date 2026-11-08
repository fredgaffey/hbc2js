// The DERIVED half of 90-inlined-new: an inlined `new Derived(...)` is
// Reflect.construct(Object.getPrototypeOf(Derived), [...], Derived), the dead
// double-super guard, then the rest of the constructor body -- at the top
// level of the defining frame and in another function.
class Base {
  constructor(a) {
    this.a = a;
  }
  who() {
    return 'B' + this.a;
  }
}

class Derived extends Base {
  #secret;
  constructor(a, s) {
    super(a);
    this.#secret = s;
  }
  reveal() {
    return this.who() + ':' + this.#secret;
  }
}

const dtop = new Derived(1, 'x');
print('dtop:', dtop.a, dtop.reveal(), dtop instanceof Base, dtop instanceof Derived);

function child(n) {
  return new Derived(n, 's' + n);
}
print('child:', child(2).reveal(), child(3).a);
