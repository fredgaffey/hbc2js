import { hashString } from './hash.js';

const KEY = 'dyn' + 'amic';

class Shape {
  static count = 0;
  static registry;
  static {
    Shape.registry = new Map();
    Shape.registry.set('base', 0);
  }
  #id;
  constructor(name) {
    this.name = name;
    this.#id = ++Shape.count;
  }
  get id() { return this.#id; }
  area() { return 0; }
  describe() { return `${this.name}#${this.#id}:${this.area()}`; }
  [KEY + 'Key']() { return 'computed-' + this.name; }
}

class Rect extends Shape {
  #w = 0;
  #h = 0;
  static #made = 0;
  constructor(w, h) {
    super('rect');
    this.#w = w;
    this.#h = h;
    Rect.#made++;
  }
  #scale(k) { this.#w *= k; this.#h *= k; return this; }
  grow(k) { return this.#scale(k); }
  get width() { return this.#w; }
  set width(v) { this.#w = Math.max(0, v); }
  area() { return this.#w * this.#h; }
  describe() { return 'R(' + super.describe() + ')'; }
  static made() { return Rect.#made; }
  static isRect(o) { return #w in o; }
}

class Square extends Rect {
  constructor(s) { super(s, s); }
  describe() { return 'S' + super.describe(); }
}

export function classFeatures() {
  const r = new Rect(2, 3);
  const s = new Square(4);
  s.grow(2);
  r.width = -5;
  r.width = 7;
  const parts = [
    r.describe(), s.describe(), r.dynamicKey(), String(Rect.made()),
    String(Rect.isRect(s)), String(Rect.isRect({})), String(s instanceof Shape),
    String(Shape.registry.get('base')), String(s.id), String(r.width),
  ];
  return parts.join('|');
}

export function accessorsAndComputed() {
  let backing = 1;
  const prefix = 'k';
  const obj = {
    get doubled() { return backing * 2; },
    set doubled(v) { backing = v / 2; },
    [prefix + 1]: 'one',
    [`${prefix}${1 + 1}`]: 'two',
    ['m' + 'ethod']() { return this.k1 + this.k2; },
  };
  obj.doubled = 42;
  const desc = Object.getOwnPropertyDescriptor(obj, 'doubled');
  return hashString(obj.method() + obj.doubled + typeof desc.get + Object.keys(obj).join());
}

export function inheritanceChain() {
  class A { who() { return 'A'; } static make() { return new this(); } }
  class B extends A { who() { return 'B' + super.who(); } }
  class C extends B {
    constructor() { super(); this.tag = 'c'; }
    who() { return 'C' + super.who(); }
  }
  const m = C.make();
  class E extends Error {
    constructor(msg) { super(msg); this.name = 'E'; }
  }
  let err = '';
  try { throw new E('bad'); } catch (e) { err = e.name + ':' + e.message + ':' + (e instanceof Error); }
  return m.who() + m.tag + '/' + err;
}
