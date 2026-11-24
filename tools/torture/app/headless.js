// Headless entry: runs every core and junk entry point and prints the
// results as one JSON line. Bundled separately (Metro -> hermesc) so the
// Hermes VM can confirm the bytecode computes what plain Node computes.
import { runCore } from './src/core/index.js';
import { JUNK_MODULES } from './src/junk/index.js';
import { entryArg } from './src/junk/_rt.js';

const emit = typeof print === 'function' ? print : (s) => console.log(s);

export async function runJunk() {
  const out = {};
  for (const path of Object.keys(JUNK_MODULES).sort()) {
    const ns = JUNK_MODULES[path];
    for (const name of Object.keys(ns).sort()) {
      if (name === '__esModule' || typeof ns[name] !== 'function') continue;
      out[path + '#' + name] = await ns[name](entryArg(name));
    }
  }
  return out;
}

runCore().then(async (core) => emit(JSON.stringify({ core, junk: await runJunk() })), (e) => emit('HEADLESS-ERROR ' + e));
