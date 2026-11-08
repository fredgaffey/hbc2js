// NEGATIVE case for the inline-new rung (spec 24 section 9): hand-written
// code that builds a receiver exactly the way hermesc's inlined `new Point()`
// does -- Object.create of the class's prototype with GetPrototypeFromCtor's
// guard -- but then writes a property the constructor never writes, BETWEEN
// the create and the constructor's own statements. It is not `new Point(...)`
// (the extra own property comes first, and `p instanceof Point` holds without
// the constructor ever running), so it must stay as written.
class Point {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
  norm() {
    return this.x * this.x + this.y * this.y;
  }
}

function lookalike(x, y) {
  const proto = Point.prototype;
  const p = Object.create(proto === null ? null : typeof proto === 'object' ? proto : Object.prototype);
  p.tag = 'fake';
  p.x = x;
  p.y = y;
  return p;
}
const real = new Point(1, 2);
const fake = lookalike(3, 4);
print('real:', Object.keys(real).join(','), real.norm());
print('fake:', Object.keys(fake).join(','), fake.norm(), fake instanceof Point);
