// A private field read from a function DECLARED inside a class member (not
// an arrow) that captures one of the member's own bindings, so hermesc keeps
// it nested in the member (a non-capturing one is hoisted out of the class:
// 109-private-field-hoisted-function). Its body loads the private name's
// symbol from the defining frame's env slot. Before the fix, private-fields
// folded the members but left that nested body alone, so the slot stayed
// mentioned and R-PF1 (defining-body-escape) refused the name -- residue on
// react-navigation, docs/BUGS.md row "E2E tier 1 -- bucket
// `diff:GetOwnPrivateBySym/GetByVal`".
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
