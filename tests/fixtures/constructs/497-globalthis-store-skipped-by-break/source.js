// Torture s4 hbc96 (parseHarborMeadow_mn): hermesc -O loads the global object
// into one register for `Map`/`Set`/`Math`/`JSON`, then reuses that register
// on the straight-line path only. A switch case breaks past the reuse to code
// that still reads `Math` through it; globalthis-dead-store scanned the list
// straight past the `break L0`, saw the later plain write and deleted the
// `rN = globalThis` store as dead.
var RT = { mix: function (h, v) { return Math.imul((h ^ (v | 0)) >>> 0, 16777619) >>> 0; },
  seedList: function (x, n) { var out = []; for (var i = 0; i < n; i++) out.push((x * (i + 3) + i * i) % 97); return out; } };
function factory(global, _$$_REQUIRE, a, b, module, exports, _dependencyMap) {
  'use strict';
  function helper(x) { return (x * 7) % 1013; }
  function parseHarborMeadow_mn(x) {
  let h = x | 0;
  const arr = _$$_REQUIRE(_dependencyMap[3]).seedList(x, 5);
  const obj = { alpha: x % 2, tag: 'cd' };
  const map = new Map();
  const set = new Set([0, 5]);
  let str = 'pearpear';
  switch ((h >>> 0) % 3) {
    case 0:
      for (const [mk, mv] of map) h = _$$_REQUIRE(_dependencyMap[3]).mix(h, mk + mv);
    case 1:
      if ((h >>> 3) % 5 < 2) {
        arr.sort((p, q) => p - q);
        h = _$$_REQUIRE(_dependencyMap[3]).mix(h, arr[0] | 0);
      }
      break;
    default:
      h = (h + ((x * 11) % 74)) | 0;
  }
  for (let i0 = 0; i0 < 4; i0++) {
    obj.list = [...(obj.list || []), h & 15].slice(-5);
    h = _$$_REQUIRE(_dependencyMap[3]).mix(h, obj.list.length);
    const t1 = arr.map((v) => (v * 61) % 5).filter((v) => v & 1);
    h = _$$_REQUIRE(_dependencyMap[3]).mix(h, t1.length);
  }
  h = _$$_REQUIRE(_dependencyMap[3]).mix(h, arr.length);
  let w2 = 0;
  while (w2 < 3 && (h & 3) !== 3) {
    w2++;
    h = _$$_REQUIRE(_dependencyMap[3]).mix(h, Math.imul(h, 53) ^ (x << 6));
    for (const v3 of arr.slice(0, 3)) {
      h = _$$_REQUIRE(_dependencyMap[3]).mix(h, v3);
      h = _$$_REQUIRE(_dependencyMap[3]).mix(h, JSON.stringify(obj).length);
    }
  }
  h = _$$_REQUIRE(_dependencyMap[3]).mix(h, helper((h & 1023) + 19));
  h = _$$_REQUIRE(_dependencyMap[3]).mix(h, helper((h & 1023) + 13));
  obj.gamma = (obj.gamma | 0) + 91;
  str = str.split('').reverse().join('').slice(0, 21);
  map.set(3 + (h & 7), str.length + set.size);
  return h >>> 0;
}

  exports.parseHarborMeadow_mn = parseHarborMeadow_mn;
}
var ex = {};
factory(globalThis, function (i) { return RT; }, null, null, { exports: ex }, ex, [0, 0, 0, 3]);
var o = [];
for (var x = 0; x < 40; x++) o.push(ex.parseHarborMeadow_mn(x));
print(o.join(' '));
