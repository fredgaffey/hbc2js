import { mix } from './hash.js';

const tick = (v) => Promise.resolve(v);

export async function asyncLoopTryFinally() {
  const log = [];
  let h = 1;
  for (let i = 0; i < 5; i++) {
    try {
      const v = await tick(i * 3);
      if (v === 9) throw new Error('nine');
      h = mix(h, v);
      log.push('ok' + v);
    } catch (e) {
      log.push('err:' + e.message);
      continue;
    } finally {
      log.push('f' + i);
    }
  }
  for (const p of [tick('x'), tick('y')]) log.push(await p);
  return log.join(' ') + '#' + h;
}

export async function asyncParallel() {
  const work = async (n) => {
    let acc = 0;
    for (let i = 0; i <= n; i++) acc += await tick(i);
    return acc;
  };
  const results = await Promise.all([work(3), work(5), work(8)]);
  const settled = await Promise.allSettled([tick(1), Promise.reject(new Error('no'))]);
  const raced = await Promise.race([tick('first'), new Promise((r) => r('second'))]);
  return results.join(',') + '|' + settled.map((s) => s.status).join(',') + '|' + raced;
}

export async function asyncGenerators() {
  async function* produce(n) {
    try {
      for (let i = 0; i < n; i++) yield await tick(i * i);
    } finally {
      // runs on early exit too
      produce.closed = (produce.closed || 0) + 1;
    }
  }
  const out = [];
  for await (const v of produce(6)) {
    if (v > 10) break;
    out.push(v);
  }
  return out.join(',') + ':' + produce.closed;
}

export async function asyncClosureState() {
  const queue = [];
  const makeWorker = (id) => async () => {
    await null;
    queue.push(id);
    await tick();
    queue.push(id * 10);
  };
  await Promise.all([makeWorker(1)(), makeWorker(2)(), makeWorker(3)()]);
  return queue.join('-');
}
