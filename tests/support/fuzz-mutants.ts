// Shared by tests/gate/parse/fuzz.test.ts and its worker threads
// (tests/support/fuzz-worker.ts). The RNG is one xorshift32 stream consumed in
// fixture order; the test advances it sequentially (mutate only, no parse) to
// record each binary's start state, so a binary can be fuzzed on any worker and
// see exactly the mutants the single-threaded loop produced.
export interface Rng {
  (): number;
  state(): number;
}

export function makeRng(seed: number): Rng {
  let state = seed >>> 0 || 1;
  const next = (() => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  }) as Rng;
  next.state = () => state;
  return next;
}

export function mutate(base: Uint8Array, rng: () => number): Uint8Array {
  const bytes = base.slice();
  const kind = rng() % 4;
  if (kind === 0) {
    const i = rng() % bytes.length;
    bytes[i] = rng() & 0xff;
  } else if (kind === 1) {
    const start = rng() % bytes.length;
    const len = 1 + (rng() % Math.min(64, bytes.length - start));
    bytes.fill(0, start, start + len);
  } else if (kind === 2) {
    return bytes.slice(0, rng() % (bytes.length + 1));
  } else {
    const slot = (rng() % 32) * 4;
    if (slot + 4 <= bytes.length) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      view.setUint32(slot, 0xffffffff, true);
    }
  }
  return bytes;
}
