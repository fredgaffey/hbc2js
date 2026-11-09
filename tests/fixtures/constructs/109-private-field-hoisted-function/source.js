// Negative twin of 108-private-field-nested-function: the function declared in
// a member captures nothing of the member, so hermesc hoists it into the
// frame that DEFINES the class -- outside the class body in the decompiled
// output, where `o.#v` is not even valid syntax. Folding the class's own
// accesses to `#v` while that function keeps reading the symbol property
// would make it read a property nothing writes any more, so private-fields
// must keep refusing this name (R-PF1, defining-body-escape) and the output
// stays symbol-keyed and runs.
class Bag {
  #n;
  constructor(n) {
    this.#n = n;
  }
  total(list) {
    // Passed as a value, so hermesc cannot inline it.
    function get(o) {
      return o.#n;
    }
    return [this, ...list].map(get).reduce(function (s, v) { return s + v; }, 0);
  }
}

const x = new Bag(1);
print('total:', x.total([new Bag(2), new Bag(5)]));
