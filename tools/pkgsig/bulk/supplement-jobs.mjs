#!/usr/bin/env node
// Emit worker.sh jobs (pkg<TAB>version<TAB>hbc) for supplement-packages.json:
// pinned versions + the latest N stable releases per package (npm registry).
// Usage: node supplement-jobs.mjs [packages.json] > jobs.tsv
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const file = process.argv[2] ?? new URL("./supplement-packages.json", import.meta.url).pathname;
const cfg = JSON.parse(readFileSync(file, "utf8"));
const cmp = (a, b) => { const p = (s) => s.split(".").map(Number); const x = p(a), y = p(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
for (const [name, pinned] of Object.entries(cfg.packages)) {
  const all = JSON.parse(execFileSync("npm", ["view", name, "versions", "--json"], { encoding: "utf8" }));
  const stable = all.filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort(cmp);
  const versions = [...new Set([...pinned, ...stable.slice(-cfg.latestStable)])];
  for (const v of versions) for (const h of cfg.hbcVersions) console.log(`${name}\t${v}\t${h}`);
}
