#!/usr/bin/env node
// tools/deps/lb1-candidate-closure.mjs -- LB1 measurement helper (docs/DEPS.md
// "Hash scheme 2"). Lists the package@version x hbc jobs to re-fingerprint so
// a fixture can be scored under a new signature scheme WITHOUT rebuilding the
// whole bulk DB: every version (in the compiled hbc-cache) of every package
// the fixture's blind pipeline derives as a CANDIDATE from the current DB
// (so precision is measured over non-truth candidates too), closed over the
// npm dependency graph recorded in the dep-cache (J4 dependency subtraction
// needs each dependency's own file present to subtract it).
//
// Usage (XDG_CACHE_HOME pointing at the CURRENT full DB):
//   node tools/deps/lb1-candidate-closure.mjs <hbc-cache-dir> <dep-cache-dir> <bundle.hbc>...
// Prints TSV `pkg<TAB>version<TAB>hbc` jobs to stdout; a summary (candidate
// counts, closure size, package@versions missing a dep-cache entry -- those
// would make dep-subtract.mjs hit the registry) to stderr.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolveDbLayers } from "../../src/deps/db.ts";
import { buildInventory } from "../../src/deps/inventory.ts";
import { deriveCandidatePackages } from "../../src/deps/candidates.ts";

const [hbcCache, depCache, ...bundles] = process.argv.slice(2);
if (!hbcCache || !depCache || bundles.length === 0) {
  console.error("usage: lb1-candidate-closure.mjs <hbc-cache-dir> <dep-cache-dir> <bundle.hbc>...");
  process.exit(2);
}
const safe = (p) => p.replace(/\//g, "__");
// hbc -> name -> [versions]
const cache = new Map();
for (const f of readdirSync(hbcCache)) {
  const m = /^(.*)@([^@]+)__hbc(\d+)\.hbc$/.exec(f);
  if (m === null) continue;
  const [, s, v, h] = m;
  const name = s.startsWith("@") ? s.replace("__", "/") : s;
  const byName = cache.get(Number(h)) ?? new Map();
  cache.set(Number(h), byName);
  (byName.get(name) ?? byName.set(name, []).get(name)).push(v);
}
const layers = resolveDbLayers({});
const missingDepCache = new Set();
const jobs = [];
for (const hbcVersion of new Set(bundles.map((b) => buildInventory(new Uint8Array(readFileSync(b))).inventory.hbcVersion))) {
  const byName = cache.get(hbcVersion) ?? new Map();
  const names = new Set();
  for (const b of bundles) {
    const { inventory } = buildInventory(new Uint8Array(readFileSync(b)));
    if (inventory.hbcVersion !== hbcVersion) continue;
    const c = deriveCandidatePackages(layers, inventory);
    console.error(`${b}: hbc${hbcVersion}, ${c.size} candidates`);
    for (const n of c) if (byName.has(n)) names.add(n);
  }
  const candidateCount = names.size;
  const queue = [...names];
  while (queue.length > 0) {
    const n = queue.pop();
    for (const v of byName.get(n) ?? []) {
      const p = join(depCache, `${safe(n)}@${v}.deps.json`);
      if (!existsSync(p)) {
        missingDepCache.add(`${n}@${v}`);
        continue;
      }
      for (const d of Object.keys(JSON.parse(readFileSync(p, "utf8")))) {
        if (!names.has(d) && byName.has(d)) {
          names.add(d);
          queue.push(d);
        }
      }
    }
  }
  let count = 0;
  for (const n of [...names].sort()) for (const v of byName.get(n)) (jobs.push(`${n}\t${v}\t${hbcVersion}`), count++);
  console.error(`hbc${hbcVersion}: ${candidateCount} candidate packages with a build, ${names.size} after dependency closure, ${count} package@version jobs`);
}
console.error(`missing dep-cache entries (would need the registry): ${missingDepCache.size}${missingDepCache.size ? " e.g. " + [...missingDepCache].slice(0, 10).join(", ") : ""}`);
console.log(jobs.join("\n"));
