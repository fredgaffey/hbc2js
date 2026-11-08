// REGRESSION (docs/BUGS.md row "E2E tier 1 -- bucket
// `diff:GetOwnPrivateBySym/GetByVal`", found building fixture 88): hermesc
// may give `CreateDerivedClass` the SAME register as its destination and its
// superclass operand -- here `CreateDerivedClass r4, r3, r2, r4, 3` at v99,
// because `A` is dead once `Arrow` exists. The emitter wrote the constructor
// into r4 and then read the superclass out of r4, printing
// `Object.setPrototypeOf(r4, r4)`, which throws "Cyclic __proto__ value" --
// at --passes=none, so every pass downstream inherited it.
// NOTE: classes are only supported by v98/v99 -- see versions.txt.
class A {
  constructor(a) {
    this.base = a;
  }
  who() {
    return 'A' + this.base;
  }
}
class Arrow extends A {
  handle = () => this.base + 1;
  constructor(x) {
    super(x);
    this.w = x;
  }
  call() {
    return this.handle() + this.w;
  }
}
const o = new Arrow(3);
print(JSON.stringify(o));
