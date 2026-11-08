// A class with a private field whose `Symbol("#n")` register is REUSED for
// unrelated values later in the defining frame. hermesc keeps the symbol in a
// register because its inlined construction of the class reads it; once
// inline-new has rebuilt that construction as `new Counter(...)`, the only
// later mentions of the register are writes and reads of unrelated values.
// private-fields' R-PF1 must not count those as escapes of the symbol.
class Counter {
  #n = 0;
  constructor(label, start) {
    this.label = label;
    this.#n = start;
  }
  get value() {
    return this.#n;
  }
  bump(k) {
    this.#n += k;
    return this.#n;
  }
}

const a = new Counter('a', 2);
const words = ['x', 'y', 'z'].map((w) => w + w);
const sizes = words.map((w) => w.length * 3);
const total = a.bump(5) + sizes[0] + sizes[1] + words.length;
print('vals:', a.label, a.value, total, words.join(','), sizes.join('+'));
print('more:', typeof a, a instanceof Counter, a.bump(-1), [total, total * 2].join('/'));
