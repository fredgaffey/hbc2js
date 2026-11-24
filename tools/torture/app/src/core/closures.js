import { mix, hashString } from './hash.js';

// Deep closures: four levels of captured variables, a captured `let` per loop
// iteration, and a closure that observes a later write to its outer binding.
export function closureLadder() {
  let outer = 3;
  const makeLevel1 = (a) => {
    let count = 0;
    return (b) => {
      const local = a * b;
      return (c) => {
        count += 1;
        return (d) => local + c * d + outer + count;
      };
    };
  };
  const l1 = makeLevel1(2);
  const l2 = l1(5);
  const l3 = l2(7);
  outer = 11; // the innermost closure must see this write
  let h = 0;
  for (let d = 0; d < 4; d++) h = mix(h, l3(d));
  h = mix(h, l2(1)(1));
  return h;
}

export function loopCaptures() {
  const fns = [];
  for (let i = 0; i < 6; i++) {
    let j = i * i;
    fns.push(() => i + j);
    j += 1; // captured per-iteration binding, mutated after capture
  }
  var shared = [];
  for (var k = 0; k < 3; k++) shared.push(() => k); // `var`: all see 3
  return fns.map((f) => f()).join(',') + '|' + shared.map((f) => f()).join(',');
}

export function memoizedFib() {
  const cache = new Map();
  function fib(n) {
    if (n < 2) return n;
    if (cache.has(n)) return cache.get(n);
    const v = (fib(n - 1) + fib(n - 2)) % 1000003;
    cache.set(n, v);
    return v;
  }
  return fib(90) * 7 + cache.size;
}

export function counterModule() {
  const make = (name) => {
    let value = 0;
    const api = {
      inc(by = 1) { value += by; return api; },
      get value() { return value; },
      label: () => `${name}:${value}`,
    };
    return api;
  };
  const a = make('a').inc().inc(4);
  const b = make('b').inc(10);
  return hashString(a.label() + b.label()) ^ (a.value * 100 + b.value);
}
