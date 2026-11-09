// REGRESSION (pf-hosted-r1, reported by the private-methods worker): R-PF1
// (defining-frame escape) only scanned the statement list the class was
// matched in. hermesc places this class inside a labelled block in the
// global frame (`L0: {...}`), while `pick` -- created by the global frame
// itself while it evaluates the `sum` computed key -- is emitted at the
// frame's TOP LEVEL, outside that block, still reading the symbol slot
// (`o[_e0_1]`). Folding the class to `#v` deleted the slot's only store, so
// `pick` read `o[undefined]` and `sum:` printed NaN. The name must stay
// symbol-keyed (spec 24 section 1.7, R-PF1) and the output must run.
//
// Re-shaped after spec 27 section 11 (closure creator placement): the first
// version declared `pick` inside `sum`, and once a closure created in ONE
// member is emitted inside that member the escape shape vanished and the
// fold became sound, so this test no longer exercised the slot scan. The
// computed key keeps the creation site in the global frame, which IS the
// slot's home, so section 11 never moves it.
let pickRef;
class Box {
  #v;
  constructor(v) {
    this.#v = v;
  }
  plus(other) {
    // Passed as a value, so hermesc cannot inline it.
    function get() {
      return other.#v;
    }
    return this.#v + [0].map(get)[0];
  }
  has(o) {
    function test() {
      if (o === null) return false;
      return #v in o;
    }
    return [0].some(test);
  }
  [(pickRef = function pick(o) { return o.#v; }, "sum")](list) {
    return list.map(pickRef).reduce(function (s, x) { return s + x; }, 0);
  }
  static peek(b) {
    function inner() {
      return b.#v * 2;
    }
    return [0].map(inner)[0];
  }
}

const a = new Box(3);
const b = new Box(4);
print('plus:', a.plus(b), b.plus(a));
print('has:', a.has(b), a.has({}), a.has(null));
print('peek:', Box.peek(a));
print('sum:', a.sum([a, b]));
