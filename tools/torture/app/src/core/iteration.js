import { mix } from './hash.js';

function* range(start, end, step = 1) {
  for (let i = start; i < end; i += step) yield i;
}

function* tree(node) {
  if (!node) return 0;
  yield* tree(node.left);
  yield node.value;
  const r = yield* tree(node.right);
  return r + 1;
}

export function generatorPipeline() {
  const out = [];
  function* take(gen, n) {
    let i = 0;
    for (const v of gen) {
      if (i++ >= n) return 'done';
      yield v;
    }
  }
  function* map(gen, f) { for (const v of gen) yield f(v); }
  for (const v of take(map(range(0, 100, 3), (x) => x * x), 8)) out.push(v);
  const t = { value: 5, left: { value: 2, left: { value: 1 }, right: { value: 3 } }, right: { value: 9 } };
  const walked = [...tree(t)];
  return out.join('+') + '=' + walked.join('<');
}

export function generatorProtocol() {
  function* g() {
    let log = '';
    try {
      const a = yield 1;
      log += 'a' + a;
      const b = yield 2;
      log += 'b' + b;
    } catch (e) {
      log += 'caught:' + e;
      yield 99;
    } finally {
      log += ':fin';
    }
    return log;
  }
  const it = g();
  const steps = [it.next().value, it.next('x').value, it.throw('boom').value];
  const end = it.next();
  const it2 = g();
  it2.next();
  const ret = it2.return('early');
  return JSON.stringify({ steps, end, ret });
}

class Countdown {
  constructor(n) { this.n = n; }
  [Symbol.iterator]() {
    let n = this.n;
    return {
      next: () => (n > 0 ? { value: n--, done: false } : { value: undefined, done: true }),
      return: () => ({ done: true }),
      [Symbol.iterator]() { return this; },
    };
  }
}

export function customIterable() {
  const vals = [...new Countdown(5)];
  const [first, , third, ...rest] = new Countdown(6);
  let early = 0;
  for (const v of new Countdown(100)) { if (v < 97) break; early += v; }
  return vals.join('') + '/' + first + third + rest.join('') + '/' + early;
}

export function labelledLoops() {
  let h = 7;
  let hits = 0;
  outer: for (let i = 0; i < 10; i++) {
    inner: for (let j = 0; j < 10; j++) {
      if (j > i) continue outer;
      if ((i * j) % 7 === 6) break outer;
      for (let k = 0; k < 3; k++) {
        if (k === j) continue inner;
        hits++;
        h = mix(h, i * 100 + j * 10 + k);
      }
    }
  }
  let w = 0;
  block: {
    while (true) {
      w++;
      if (w > 4) break block;
    }
  }
  return mix(h, hits * 1000 + w);
}

export function bigSwitch() {
  const classify = (n) => {
    switch (n % 17) {
      case 0: return 'zero';
      case 1:
      case 2: return 'low';
      case 3: { const t = n * 2; return 't' + t; }
      case 4: n += 1; // fallthrough
      case 5: return 'five-ish' + n;
      case 6: return 'six';
      case 7: if (n > 50) return 'big7'; break;
      case 8: return 'eight';
      case 9: return String(n & 3);
      case 10: return 'ten';
      case 11: case 12: case 13: return 'teen' + (n % 3);
      case 14: return 'fourteen';
      case 15: break;
      default: return 'dflt';
    }
    return 'broke' + n;
  };
  const words = [];
  for (let i = 0; i < 60; i++) words.push(classify(i));
  const s = (v) => {
    switch (v) {
      case 'a': return 1;
      case 'bb': return 2;
      case 'ccc': return 3;
      default: return v.length * 10;
    }
  };
  return words.join(',').length * 1000 + s('a') + s('bb') + s('ccc') + s('dddd');
}
