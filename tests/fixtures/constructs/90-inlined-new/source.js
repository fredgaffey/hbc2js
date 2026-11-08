// hermesc's inliner pulls a `new C(...)` of a class it can see into the
// calling frame: Object.create(C.prototype) (or Reflect.construct for a
// derived class) followed by the constructor's body. Here a base class with a private field is
// constructed directly, at the top level of the defining frame AND in
// another function, so the inlined shape is the one the docs/BUGS.md row
// "E2E tier 1 -- bucket `diff:GetOwnPrivateBySym/GetByVal`" names.
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

const top = new Account('top', 10);
print('top:', top.owner, top.balance, top.deposit(5).balance, top instanceof Account);

function open(name) {
  const acc = new Account(name, 3);
  return acc.deposit(4);
}
print('open:', open('o').owner, open('p').balance);
