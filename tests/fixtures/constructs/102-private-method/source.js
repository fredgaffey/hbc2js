// A class with a private METHOD. hermesc lowers `#bump` to an ordinary
// function created once in the frame that defines the class and kept in an
// env slot, plus a brand symbol the constructor installs on every instance;
// each `this.#bump(...)` becomes a brand check followed by
// `Reflect.apply(slot, receiver, args)`. Before spec 24 section 1.7.1 the
// method's body (which reads `#n`) sat outside the class body, so
// private-fields refused `#n` as defining-body-escape.
class Counter {
  #n;
  constructor(start) {
    this.#n = start;
  }
  // Recursive, so hermesc cannot inline it into its callers.
  #bump(k) {
    if (k > 1) {
      this.#bump(k - 1);
      return this.#bump(1);
    }
    this.#n = this.#n + k;
    return this.#n;
  }
  add(k) {
    return this.#bump(k);
  }
  twice(k) {
    this.#bump(k);
    return this.#bump(k);
  }
}

const c = new Counter(1);
print('add:', c.add(2));
print('twice:', c.twice(3));
try {
  Counter.prototype.add.call({}, 1);
} catch (e) {
  print('foreign:', e instanceof TypeError);
}
