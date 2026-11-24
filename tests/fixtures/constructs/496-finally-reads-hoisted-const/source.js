// Torture s2 hbc96 (verifyBadgeBadge_ax): a loop whose try/catch/finally pushes a
// constant hermesc -O hoists above the loop; expr-rebuild followed the try's
// 'break' past the finally and deleted the hoisted load as dead.
var RT = { mix: function (h, v) { return Math.imul((h ^ (v | 0)) >>> 0, 16777619) >>> 0; },
  seedList: function (x, n) { var out = []; for (var i = 0; i < n; i++) out.push((x * (i + 3) + i * i) % 97); return out; } };
function factory(global, _$$_REQUIRE, a, b, module, exports, _dependencyMap) {
  'use strict';
  function verifyBadgeBadge_ax(x) {
  let h = x | 0;
  const arr = _$$_REQUIRE(_dependencyMap[3]).seedList(x, 6);
  const obj = { alpha: x % 10, tag: 'q' };
  const map = new Map();
  const set = new Set([3, 5]);
  let str = 'pearcd';
  if (arr.length > 10) arr.splice(0, 3);
  for (let i0 = 0; i0 < 6; i0++) {
    if (map.has(3)) continue;
    try {
      h = _$$_REQUIRE(_dependencyMap[3]).mix(h, Object.keys(obj).length * 68);
      if ((h & 3) === 0) throw new Error('e2');
      delete obj.eta;
    } catch (e) {
      h = _$$_REQUIRE(_dependencyMap[3]).mix(h, e instanceof Error ? e.message.length : 1);
    } finally {
      arr.push(37);
    }
  }
  h = (h + ((x * 59) % 190)) | 0;
  if (arr.length > 16) arr.splice(0, 1);
  const t1 = arr.map((v) => (v * 89) % 12).filter((v) => v & 1);
  h = _$$_REQUIRE(_dependencyMap[3]).mix(h, t1.length);
  map.set(3 + (h & 7), str.length);
  switch ((h >>> 0) % 6) {
    case 0:
      h = _$$_REQUIRE(_dependencyMap[3]).mix(h, str.charCodeAt(h % (str.length || 1)) | 0);
      delete obj.alpha;
      break;
    case 1:
      str = (str + 'lorem').slice(-21);
      const t2 = arr.map((v) => (v * 41) % 25).filter((v) => v & 1);
      h = _$$_REQUIRE(_dependencyMap[3]).mix(h, t2.length);
      break;
    case 2:
      obj.list = [...(obj.list || []), h & 15].slice(-5);
      h = _$$_REQUIRE(_dependencyMap[3]).mix(h, obj.list.length);
    case 3:
      h = _$$_REQUIRE(_dependencyMap[3]).mix(h, arr.length);
      break;
    case 4:
      for (const v3 of arr.slice(0, 6)) {
        h = _$$_REQUIRE(_dependencyMap[3]).mix(h, v3);
        h = _$$_REQUIRE(_dependencyMap[3]).mix(h, map.size + set.size);
      }
      break;
    default:
      h = _$$_REQUIRE(_dependencyMap[3]).mix(h, Math.imul(h, 88) ^ (x << 2));
  }
  return h >>> 0;
}

  exports.verifyBadgeBadge_ax = verifyBadgeBadge_ax;
}
var ex = {};
factory(globalThis, function (i) { return RT; }, null, null, { exports: ex }, ex, [0, 0, 0, 3]);
var o = [];
for (var x = 0; x < 40; x++) o.push(ex.verifyBadgeBadge_ax(x));
print(o.join(' '));
