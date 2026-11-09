// Spec 24 section 1.7.1's REGISTER-HOP private-method shape (pf-hosted-r1):
// with several methods hermesc stores each closure through one recycled
// register (`r8 = _fnK; _e0_2 = r8; r8 = _fnJ; ...`) rather than straight
// into its env slot. At v99 `#step` is folded through that hop. At v98
// hermesc inlines `#step` into `bump` with brand checks the dominance scan
// does not prove, so the class stays refused (`pm-undominated-call`) and
// symbol-keyed; it must still run.
class Meter {
  #v;
  #log = [];
  constructor(v) {
    this.#v = v;
  }
  #step(k) {
    if (k > 1) {
      this.#step(k - 1);
      return this.#step(1);
    }
    this.#v = this.#v + k;
    this.#log.push(k);
    return this.#v;
  }
  #reset(to) {
    if (to < 0) {
      return this.#reset(0);
    }
    this.#v = to;
    return this.#v;
  }
  bump(k) {
    return this.#step(k);
  }
  zero() {
    const r = this.#reset(-1);
    return r + this.#log.length;
  }
  get v() {
    return this.#v;
  }
}
const m = new Meter(2);
print('bump:', m.bump(3), m.v);
print('zero:', m.zero(), m.v);
