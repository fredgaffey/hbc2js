// tools/deps/build-candidate-hash-index.mjs -- writes the hash-index candidate
// proposal files (src/deps/hash-index.ts, docs/DEPS.md "Hash-index candidate
// proposal") for a JSON signature directory. Usage:
//   node --experimental-strip-types tools/deps/build-candidate-hash-index.mjs <sigdir> [--out <dir>] [--hbc 96,98]
// Default --out is <sigdir> itself; default --hbc is every version present.
// One file per HBC version: <out>/candidate-hash-index__hbc<N>.tsv.
import { statSync } from "node:fs";
import { sigHbcVersions, writeCandidateHashIndex } from "../../src/deps/hash-index.ts";

const args = process.argv.slice(2);
const sigDir = args[0];
if (sigDir === undefined || sigDir.startsWith("--")) {
  console.error("usage: build-candidate-hash-index.mjs <sigdir> [--out <dir>] [--hbc 96,98]");
  process.exit(2);
}
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const outDir = flag("--out") ?? sigDir;
const hbcs = flag("--hbc") !== undefined ? flag("--hbc").split(",").map(Number) : sigHbcVersions(sigDir);
for (const hbc of hbcs) {
  const t0 = Date.now();
  const path = writeCandidateHashIndex(sigDir, outDir, hbc);
  console.log(`hbc${hbc}: ${path} ${(statSync(path).size / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
