// finally-dedup R-FD9 (docs/BUGS.md finally-dedup-register-mismatch, found by
// the torture benchmark at 10k functions). Hermes emits a try/catch/finally
// as a normal-path copy of the finalizer plus a catch-all handler copy that
// ends in a rethrow. Because the handler copy rethrows, its scratch registers
// may be ones that are still live on the normal path: here `arr.push(29)`
// puts its receiver Mov in the register holding `str` and its (unused) result
// in the register holding `arr`. Printing that handler copy as a JS `finally`
// clobbered `arr` (so `arr.slice` threw) and `str`.
function mix(h, v) { return (Math.imul(h ^ v, 16777619) + 7) | 0; }
function seedList(x, n) { var a = []; for (var i = 0; i < n; i++) a.push((x * 7 + i * 13) % 97); return a; }
function scratchInFinally(x) {
  let h = x | 0;
  const arr = seedList(x, 6);
  const set = new Set([1, 8]);
  let str = 'qmno';
  switch ((h >>> 0) % 4) {
    case 0:
      try {
        if ((h >>> 3) % 5 < 2) throw new Error('e49');
        h = mix(h, 5);
      } catch (e) {
        h = mix(h, e.message.length);
      } finally {
        arr.push(29);
      }
      break;
    default:
      str = str.slice(0, 2);
  }
  h = mix(h, set.size + str.length);
  for (const v1 of arr.slice(0, 4)) h = mix(h, v1);
  return h >>> 0;
}
// The torture shape: a nested switch with fallthrough beside the finally case.
function scratchInFinallyFallthrough(x) {
  let h = x | 0;
  const arr = seedList(x, 6);
  const set = new Set([1, 8]);
  let str = 'qmno';
  switch ((h >>> 0) % 4) {
    case 0:
      try {
        if ((h >>> 3) % 5 < 2) throw new Error('e49');
        h = mix(h, 5);
      } catch (e) {
        h = mix(h, e instanceof Error ? e.message.length : 1);
      } finally {
        arr.push(29);
      }
      break;
    case 2:
      switch ((h >>> 0) % 6) {
        case 1:
          arr.push((h + 94) % 215);
          break;
        case 2:
          h = mix(h, arr[0] | 0);
        case 3:
          h = (h + ((x * 60) % 292)) | 0;
        case 4:
          arr.push((h + 58) % 247);
          break;
      }
      break;
    default:
      str = str.slice(0, 2);
  }
  h = mix(h, set.size + str.length);
  for (const v1 of arr.slice(0, 4)) h = mix(h, v1);
  return h >>> 0;
}
var a = [], b = [];
for (var i = 0; i < 16; i++) { a.push(scratchInFinally(i * 37)); b.push(scratchInFinallyFallthrough(i * 37)); }
print(a.join(','));
print(b.join(','));
