// A class member that reads a private name inside a loop: hermesc reloads the
// name's symbol from the defining frame's env slot into a register inside the
// loop body, then reads `this[reg]`. private-fields' member scan treated the
// whole loop as one leaf, so the slot stayed mentioned and R-PF1
// (defining-body-escape) refused the name -- residue on react-navigation,
// docs/BUGS.md row "E2E tier 1 -- bucket `diff:GetOwnPrivateBySym/GetByVal`".
class Handlers {
  #props;
  #tag = -1;
  constructor(props) {
    this.#props = props;
    this.#tag = 7;
  }
  attach() {
    const p = this.#props;
    let out = 0;
    for (const k in p) {
      if (k === 'skip') continue;
      out += p[k](this.#tag);
    }
    return out;
  }
  count() {
    let n = 0;
    let i = 0;
    while (i < 3) {
      n += this.#tag;
      i++;
    }
    return n;
  }
}

const h = new Handlers({ a: (t) => t + 1, skip: () => 100, b: (t) => t * 2 });
print('attach:', h.attach());
print('count:', h.count());
