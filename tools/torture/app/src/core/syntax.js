import { hashString } from './hash.js';

export function optionalAndNullish() {
  const data = { user: { profile: { name: 'ada', tags: ['x'] }, settings: null }, list: [{ v: 0 }] };
  const parts = [
    data.user?.profile?.name,
    data.user?.settings?.theme ?? 'default',
    data.missing?.deep.deeper,
    data.user.profile.tags?.[0],
    data.list?.[0]?.v ?? 'nullish-not-falsy',
    data.list[0].v || 'falsy',
    data.fn?.(),
    data.user.profile.toString?.call(1) ? 'callable' : 'no',
  ];
  let x = null;
  x ??= 5;
  let y = 0;
  y ||= 7;
  let z = 1;
  z &&= 9;
  return parts.map(String).join(',') + ':' + x + y + z;
}

function tag(strings, ...values) {
  return strings.raw.map((s, i) => s + (i < values.length ? `[${typeof values[i]}:${values[i]}]` : '')).join('');
}

export function taggedTemplates() {
  const a = 5;
  const b = 'str';
  const first = tag`one ${a} two ${b} three\n`;
  const same = (s) => s;
  // Per-site template-object identity: Babel dedupes identical literals at
  // different sites (Node does not), so only same-site identity is checked.
  const cache = [];
  for (let i = 0; i < 2; i++) cache.push(same`loop`);
  const nested = `outer ${`inner ${a * 2}`} done`;
  return hashString(first + nested) + ':' + (cache[0] === cache[1]) + String.raw`a\tb`.length;
}

export function destructuringDefaults() {
  const config = { host: 'h', port: undefined, nested: { depth: 2 }, list: [1, , 3] };
  const { host, port = 8080, nested: { depth, width = depth * 3 } = {}, list: [p, q = 'hole', r], missing = 'dflt', ...others } = config;
  const swap = (() => { let m = 1, n = 2; [m, n] = [n, m]; return `${m}${n}`; })();
  const fn = ({ a = 1, b: { c = 2 } = {} } = {}, [d = 4] = []) => a + c + d;
  const pairs = Object.entries({ k: 1, j: 2 }).map(([k, v]) => k + v);
  return [host, port, depth, width, p, q, r, missing, Object.keys(others).join(), swap, fn(), fn({ a: 10, b: { c: 20 } }, [30]), pairs.join()].join('|');
}

export function spreadAndRest() {
  const base = { a: 1, b: 2 };
  const merged = { ...base, b: 3, ...{ c: 4 }, ...null, ...'hi' };
  const arr = [...[1, 2], ...new Set([3, 3, 4]), ...'ab'];
  const max = Math.max(...arr.filter((v) => typeof v === 'number'));
  const collect = (first, ...rest) => rest.length * 10 + first;
  const { a, ...restObj } = merged;
  return JSON.stringify({ merged, arr, max, c: collect(...arr), a, restObj });
}
