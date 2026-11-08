// Two classes with private fields, each constructed (and so inlined by
// hermesc) at the top level of the defining frame. The second inlined
// constructor's brand-check throw is shared, so the structurer opens
// `L0: { ... }` around the WHOLE frame -- class definitions included -- and
// class-recover's F1 must see through that labelled block (spec 24 section
// 3.1). Before that fix no class at all was recovered here.
class Account {
  #balance = 0;
  constructor(owner, start) {
    this.owner = owner;
    this.#balance = start;
  }
  get balance() {
    return this.#balance;
  }
  deposit(n) {
    this.#balance += n;
    return this;
  }
}

class Base {
  constructor(a) {
    this.a = a;
  }
  who() {
    return 'B' + this.a;
  }
}

class Derived extends Base {
  #secret;
  constructor(a, s) {
    super(a);
    this.#secret = s;
  }
  reveal() {
    return this.who() + ':' + this.#secret;
  }
}

const top = new Account('top', 10);
print('top:', top.owner, top.balance, top.deposit(5).balance, top instanceof Account);
const dtop = new Derived(1, 'x');
print('dtop:', dtop.a, dtop.reveal(), dtop instanceof Base, dtop instanceof Derived);
