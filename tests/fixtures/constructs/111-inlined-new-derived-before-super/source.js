// Negative twin of 110-inlined-new-derived-residue: the derived constructor
// runs user code before `super()`. inline-new must keep refusing it (R-IN1):
// the call before super is not the dead getPrototypeOf residue, and it prints.
class Base {
  constructor(v) {
    this.v = v;
  }
}

class Child extends Base {
  #w;
  constructor(v) {
    const t = tag(v);
    super(t);
    this.#w = v * 2;
  }
  get w() {
    return this.#w;
  }
}

function tag(v) {
  print('tag', v);
  return 'T' + v;
}

const c = new Child(3);
print('child:', c.v, c.w);
