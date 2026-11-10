// review-1110 objlit/fold negative control: derived constructors whose
// loop-carried registers live in the same frame as super() (strict
// expressionOnlyCheck), including super() only inside an arrow and a
// derived ctor that returns an object without calling super().
class A { constructor(x) { this.x = x; } }
class B extends A {
  constructor(n) {
    var t, s = 0;
    for (var i = 0; i < n; i++) { var p = t; t = i + s; s = p === undefined ? 1 : p; }
    super(t + s);
    print("B", this.x);
  }
}
new B(3);
class C extends A {
  constructor(n) {
    const f = () => super(n * 2);
    var u, v = 1;
    for (var i = 0; i < 2; i++) { var w = u; u = v + i; v = w === undefined ? 7 : w; }
    f();
    print("C", this.x, u, v);
  }
}
new C(4);
class D extends A {
  constructor(n) { if (n > 1) { super(n); } else { return { x: "obj" }; } print("D", this.x); }
}
print(new D(5).x, new D(0).x);
