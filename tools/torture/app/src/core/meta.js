import { hashValue } from './hash.js';

export function proxyReflect() {
  const log = [];
  const target = { a: 1, b: 2 };
  const p = new Proxy(target, {
    get(t, k, r) { log.push('get:' + String(k)); return k in t ? Reflect.get(t, k, r) : 'missing'; },
    set(t, k, v, r) { log.push('set:' + String(k)); return Reflect.set(t, k, v * 10, r); },
    has(t, k) { return k !== 'hidden' && Reflect.has(t, k); },
    deleteProperty(t, k) { log.push('del:' + String(k)); return Reflect.deleteProperty(t, k); },
    ownKeys(t) { return Reflect.ownKeys(t).filter((k) => k !== 'b'); },
  });
  p.c = 3;
  const x = p.a + p.c + p.zzz;
  delete p.a;
  const keys = Object.keys(p);
  const has = ['c' in p, 'hidden' in p];
  const fnProxy = new Proxy(function add(a, b) { return a + b; }, {
    apply(t, self, args) { return Reflect.apply(t, self, args) * 2; },
  });
  const built = Reflect.construct(Date, [0]).getTime();
  return hashValue({ x, keys, has, log, call: fnProxy(3, 4), built, own: Reflect.ownKeys({ z: 1, [Symbol.for('s')]: 2 }).length });
}

export function weakCollections() {
  const meta = new WeakMap();
  const seen = new WeakSet();
  const objs = [];
  for (let i = 0; i < 5; i++) {
    const o = { i };
    objs.push(o);
    meta.set(o, i * i);
    if (i % 2) seen.add(o);
  }
  let total = 0;
  for (const o of objs) total += (meta.get(o) || 0) + (seen.has(o) ? 100 : 0);
  meta.delete(objs[0]);
  return total + (meta.has(objs[0]) ? 1000 : 0);
}

export function symbolsAndDescriptors() {
  const s1 = Symbol('local');
  const s2 = Symbol.for('global.key');
  const o = { [s1]: 1, [s2]: 2, plain: 3 };
  Object.defineProperty(o, 'hidden', { value: 4, enumerable: false });
  const frozen = Object.freeze({ k: 1 });
  // Reflect.set reports the failed write without depending on strictness
  // (Metro/hermesc and Node disagree on sloppy vs strict module bodies).
  const wrote = String(Reflect.set(frozen, 'k', 2)) + frozen.k;
  return [
    Object.keys(o).join(), Object.getOwnPropertySymbols(o).length, Symbol.keyFor(s2),
    s1.description, o.hidden, Object.isFrozen(frozen), wrote,
  ].join('|');
}
