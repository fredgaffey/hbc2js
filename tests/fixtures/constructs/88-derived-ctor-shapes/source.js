// Explicit DERIVED constructors in the shapes the bucket
// `diff:GetOwnPrivateBySym/GetByVal` row and spec 26 section 10 name:
// a plain `super(x); this.y = x;`, public class fields, an arrow class field,
// code before `super(...)` that does not touch `this`, and a CONDITIONAL
// super call, which a super-rebuilding rung must refuse (one `super(...)` per
// path is not one `super(...)` statement). Private fields are fixture 81's.
// NOTE: classes are only supported by v98/v99 among the hermesc versions
// this project fetches -- see versions.txt.
class A {
  constructor(a) {
    this.base = a;
  }
  who() {
    return 'A' + this.base;
  }
}

class Plain extends A {
  constructor(x) {
    super(x);
    this.y = x;
  }
  sum() {
    return this.base + this.y;
  }
}

class Fields extends A {
  count = 2;
  label = 'f';
  constructor(x) {
    super(x * 2);
    this.z = x + this.count;
  }
  show() {
    return this.label + this.z;
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

class Before extends A {
  constructor(x) {
    const doubled = x * 2;
    print('before super', doubled);
    super(doubled + 1);
    this.d = doubled;
  }
  get pair() {
    return this.base + ':' + this.d;
  }
}

class Cond extends A {
  constructor(x) {
    if (x > 0) {
      super(x);
    } else {
      super(-x);
    }
    this.c = x;
  }
  sign() {
    return this.c > 0 ? '+' : '-';
  }
}

// Constructed from a separate function, so hermesc's inliner does not pull
// the constructors into the class-defining frame (that shape is fixture 89's
// and the docs/BUGS.md row's `defining-body-escape` residue).
function main() {
  const p = new Plain(3);
  print('plain:', p.base, p.y, p.sum(), p.who(), p instanceof A);
  const f = new Fields(4);
  print('fields:', f.base, f.count, f.label, f.z, f.show());
  const a = new Arrow(5);
  print('arrow:', a.base, a.w, a.handle(), a.call());
  const b = new Before(6);
  print('before:', b.base, b.d, b.pair);
  const c1 = new Cond(7);
  const c2 = new Cond(-8);
  print('cond:', c1.base, c1.c, c1.sign(), c2.base, c2.c, c2.sign());
}
main();
