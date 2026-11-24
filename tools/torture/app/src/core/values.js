import { hashString } from './hash.js';

export function bigIntMath() {
  let f = 1n;
  for (let i = 1n; i <= 30n; i++) f *= i;
  const mod = f % 1000000007n;
  const big = 2n ** 100n;
  const mixed = BigInt(Number.MAX_SAFE_INTEGER) + 2n;
  const neg = -(7n / 2n);
  return [mod.toString(), (big >> 64n).toString(16), mixed.toString(), String(neg), typeof f, (f > 10n ** 30n)].join('|');
}

export function regexNamedGroups() {
  const re = /(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})/g;
  const text = 'from 2024-01-15 to 2025-12-31 and 1999-07-04';
  const found = [];
  let m;
  while ((m = re.exec(text)) !== null) found.push(`${m.groups.day}/${m.groups.month}/${m.groups.year}`);
  const swapped = text.replace(/(?<y>\d{4})-(?<mo>\d{2})/g, '$<mo>.$<y>');
  const sticky = /ab/y;
  sticky.lastIndex = 2;
  const flags = [sticky.test('xxab'), /\u{1F600}/u.test('\u{1F600}'), /a.b/s.test('a\nb')];
  const all = [...'a1b22c333'.matchAll(/\d+/g)].map((x) => x[0] + '@' + x.index);
  return hashString(found.join() + swapped + flags.join() + all.join());
}

export function intlFormatting() {
  // Guarded: the Hermes CLI may be built without Intl; the fallback strings
  // are exactly what en-US produces, so the checksum is engine-independent.
  const hasIntl = typeof Intl !== 'undefined' && typeof Intl.NumberFormat === 'function';
  const num = hasIntl ? new Intl.NumberFormat('en-US').format(1234567.5) : '1,234,567.5';
  let plural = 'other';
  try {
    plural = hasIntl && Intl.PluralRules ? new Intl.PluralRules('en-US').select(1) : 'one';
  } catch (e) {
    plural = 'one';
  }
  const fixed = (1234.5678).toFixed(2) + '|' + (0.000123).toExponential(1) + '|' + (255).toString(16);
  return num + '|' + plural + '|' + fixed;
}

export function jsonRoundTrip() {
  const value = {
    s: 'quote " backslash \\ newline \n unicode é  ',
    n: [0, -0, 1.5, 1e21, -3],
    nested: { arr: [[], {}, [null, true, false]] },
    skip: undefined,
    date: '2020-01-01T00:00:00.000Z',
  };
  const text = JSON.stringify(value, null, 2);
  const back = JSON.parse(text, (k, v) => (k === 'date' ? 'revived:' + v : v));
  const replaced = JSON.stringify(back, (k, v) => (typeof v === 'number' ? v * 2 : v));
  const custom = JSON.stringify({ toJSON() { return { custom: 1 }; } });
  return hashString(text) + ':' + hashString(replaced) + ':' + custom + ':' + ('skip' in back);
}

export function collectionsMix() {
  const m = new Map([[1, 'a'], ['1', 'b'], [NaN, 'nan']]);
  m.set(NaN, 'nan2');
  const s = new Set([1, '1', 1, NaN, NaN, 0, -0]);
  const grouped = {};
  for (const w of ['apple', 'avocado', 'banana', 'blueberry', 'cherry']) (grouped[w[0]] ??= []).push(w.length);
  const sorted = [5, 1, 10, 2].sort((a, b) => a - b).concat([5, 1, 10, 2].sort());
  const arr = Array.from({ length: 5 }, (_, i) => i * i).flatMap((v) => [v, -v]).filter(Boolean);
  return JSON.stringify({ msize: m.size, nan: m.get(NaN), ssize: s.size, grouped, sorted, arr, at: arr.at(-1), inc: arr.includes(-16) });
}
