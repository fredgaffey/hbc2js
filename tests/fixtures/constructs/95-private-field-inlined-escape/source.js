// The symbol genuinely escapes in the defining frame: hermesc inlines
// `new Gate(...)` whose constructor has a loop and a conditional (shapes the
// inline-new rung does not model, R-IN1), so the inlined copy keeps a
// symbol-keyed install of `#open` on an object built outside the class's own
// [[Construct]]. Folding the class's accessors to `this.#open` would make
// that object's reads throw, so private-fields must still refuse (R-PF1).
class Gate {
  #open = false;
  constructor(n) {
    let s = 0;
    for (let i = 0; i < n; i++) s += i;
    if (s > 3) this.#open = true;
    this.sum = s;
  }
  get open() {
    return this.#open;
  }
  toggle() {
    this.#open = !this.#open;
    return this.#open;
  }
}

const g = new Gate(4);
print('g:', g.sum, g.open, g.toggle(), g.open);
const h = new Gate(1);
print('h:', h.sum, h.open, h.toggle());
