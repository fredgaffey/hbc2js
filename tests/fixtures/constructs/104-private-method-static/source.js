// A STATIC private method (spec 24 section 1.7.1, observed shape). hermesc
// checks the brand on the class itself but passes `0` as the receiver of the
// `Reflect.apply` (the body never reads `this`), so no brand check dominates
// the call and the private-methods step refuses (pm-undominated-call). The
// output stays symbol-keyed and correct.
class K {
  static #n = 0;
  static #tick(k) {
    if (k > 1) {
      K.#tick(k - 1);
      return K.#tick(1);
    }
    K.#n = K.#n + k;
    return K.#n;
  }
  static go(k) {
    return K.#tick(k);
  }
}
print('static:', K.go(3));
print('again:', K.go(1));
