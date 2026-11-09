// Spec 24 section 1.7.1's HOSTED private-method shape (pf-hosted-r1): the
// early-exit `if` makes hermesc host the class, its slot stores and the
// `#bump` slot store inside a labelled block in `make`'s body, while the
// `#bump` function itself is declared at that body's top level, outside the
// block. `foldHosted` must still move `#bump` into the class and fold `#n`
// at v98 and v99; the frame-wide R-PF1 slot check (fixture 180) must not
// count the method function it is moving as an escape.
function make(k) {
  let out = null;
  if (k < 0) {
    print('neg');
  } else {
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
    
    out = Counter;
  }
  return out;
}
const Counter = make(1);
make(-1);
const c = new Counter(1);
print('add:', c.add(2));
print('twice:', c.twice(3));
try {
  Counter.prototype.add.call({}, 1);
} catch (e) {
  print('foreign:', e instanceof TypeError);
}
