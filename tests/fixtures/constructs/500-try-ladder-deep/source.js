// A generator with many try/catch regions, each around a yield. hermesc
// lowers it to one state machine whose exception regions all over-reach the
// structured body, so the decompiler guards each handler on __pc and nested
// them one per region: at hundreds of regions the Hermes compiler's optimiser
// ran out of memory compiling the decompile (bare RN 0.88 app, fn#37772,
// >18 GB). Expected: every region's catch still sees only its own throws.
function* steps(fail) {
  var log = [];
  try { log.push(yield 0); if (fail === 0) throw new Error("f0"); } catch (e) { log.push("c" + e.message); }
  try { log.push(yield 1); if (fail === 1) throw new Error("f1"); } catch (e) { log.push("c" + e.message); }
  try { log.push(yield 2); if (fail === 2) throw new Error("f2"); } catch (e) { log.push("c" + e.message); }
  try { log.push(yield 3); if (fail === 3) throw new Error("f3"); } catch (e) { log.push("c" + e.message); }
  try { log.push(yield 4); if (fail === 4) throw new Error("f4"); } catch (e) { log.push("c" + e.message); }
  try { log.push(yield 5); if (fail === 5) throw new Error("f5"); } catch (e) { log.push("c" + e.message); }
  try { log.push(yield 6); if (fail === 6) throw new Error("f6"); } catch (e) { log.push("c" + e.message); }
  try { log.push(yield 7); if (fail === 7) throw new Error("f7"); } catch (e) { log.push("c" + e.message); }
  try { log.push(yield 8); if (fail === 8) throw new Error("f8"); } catch (e) { log.push("c" + e.message); }
  try { log.push(yield 9); if (fail === 9) throw new Error("f9"); } catch (e) { log.push("c" + e.message); }
  try { log.push(yield 10); if (fail === 10) throw new Error("f10"); } catch (e) { log.push("c" + e.message); }
  try { log.push(yield 11); if (fail === 11) throw new Error("f11"); } catch (e) { log.push("c" + e.message); }
  try { log.push(yield 12); if (fail === 12) throw new Error("f12"); } catch (e) { log.push("c" + e.message); }
  try { log.push(yield 13); if (fail === 13) throw new Error("f13"); } catch (e) { log.push("c" + e.message); }
  try { log.push(yield 14); if (fail === 14) throw new Error("f14"); } catch (e) { log.push("c" + e.message); }
  try { log.push(yield 15); if (fail === 15) throw new Error("f15"); } catch (e) { log.push("c" + e.message); }
  try { log.push(yield 16); if (fail === 16) throw new Error("f16"); } catch (e) { log.push("c" + e.message); }
  try { log.push(yield 17); if (fail === 17) throw new Error("f17"); } catch (e) { log.push("c" + e.message); }
  try { log.push(yield 18); if (fail === 18) throw new Error("f18"); } catch (e) { log.push("c" + e.message); }
  try { log.push(yield 19); if (fail === 19) throw new Error("f19"); } catch (e) { log.push("c" + e.message); }
  return log.join(",");
}
function run(fail, poison) {
  var g = steps(fail);
  var r = g.next();
  var k = 0;
  while (!r.done) {
    k++;
    r = k === poison ? g.throw(new Error("p" + k)) : g.next(k * 3);
  }
  return r.value;
}
print(run(-1, -1));
print(run(4, 7));
print(run(19, 1));
print(run(10, 20));
