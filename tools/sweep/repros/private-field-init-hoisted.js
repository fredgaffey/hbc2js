// sweep 2026-11-24, react-navigation hbc98 fn#3023 (class O): a private field
// initialiser that reads a global; the folded `#e = new r3()` reads a register
// that only the constructor body assigned.
class O {
  #e = new Map();
  #n = 0;
  add(k) { this.#e.set(k, ++this.#n); return this; }
  get size() { return this.#e.size; }
}
var o = new O();
o.add("a").add("b");
print(o.size);
