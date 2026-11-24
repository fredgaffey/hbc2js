// A generator that yields inside a nested if of a string switch with a
// fallthrough default, all inside try/catch (app-fuzz cfg05, hbc96).
function mix(h, v) { return ((h * 31) ^ v) >>> 0; }
function* gen(x, h) {
  let c = x & 7;
  const o = { k: x % 5, z: null };
  try {
    c ||= 1;
    o.z ??= 6;
    switch ('k' + (x % 4)) {
      case 'k0':
        if ((c ^ 47) < 296) {
          if ((x ^ 42) < 40) {
            h = mix(h, c * 12 + 8);
          } else {
            h = mix(h, (yield !(h & 1) || h > 736 ? 32 : h - 1) ?? 7);
          }
        } else {
          c ||= 1;
          o.z ??= 3;
        }
        break;
      default:
        h = mix(h, 813);
      case 'k1':
      case 'k2':
        c ||= 2;
        o.z ??= 3;
        break;
    }
    try {
    } catch (e2) {
    }
  } catch (e) {
  }
  return h >>> 0;
}
function run(x) {
  const it = gen(x, x | 0);
  const out = [];
  let st = it.next();
  let k = 0;
  while (!st.done && k < 5) { out.push(String(st.value)); st = it.next(k * 3 + 1); k++; }
  out.push('done ' + st.value);
  return out.join(',');
}
for (const x of [0, 3, 4, 5, 7, 40, 44, 41, 100]) print(x + ': ' + run(x));
