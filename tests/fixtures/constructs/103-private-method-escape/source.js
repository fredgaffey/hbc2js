// Negative twin of 102-private-method (spec 24 section 1.7.1): the private
// method `#bump` is also READ AS A VALUE (`get bumper`), so its env slot is
// read outside a `Reflect.apply` callee position. The private-methods step
// must refuse the whole class (and `#n` with it); the output stays
// symbol-keyed and correct. The getter also pins identity: one function
// object per class evaluation, shared by every instance.
class Counter {
  #n;
  constructor(start) {
    this.#n = start;
  }
  #bump(k) {
    if (k > 1) {
      this.#bump(k - 1);
      return this.#bump(1);
    }
    this.#n = this.#n + k;
    return this.#n;
  }
  get bumper() {
    return this.#bump;
  }
  add(k) {
    return this.#bump(k);
  }
}

const c = new Counter(1);
const d = new Counter(10);
print('add:', c.add(2));
print('same:', c.bumper === d.bumper);
print('call:', c.bumper.call(d, 3));
