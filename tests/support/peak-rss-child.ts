// Child process for tests/sweep/decompile/peak-memory-budget.test.ts. Run in
// its own `node --max-old-space-size=<n>` process (spawned, never imported)
// so `process.resourceUsage().maxRSS` reflects only this decompile, not the
// parent test runner's own footprint or any sibling test file. Prints one
// JSON line to stdout and nothing else, so a decompile that happens to write
// warnings to stderr never corrupts the measurement.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { splitProject } from "../../src/split/index.ts";

const path = process.argv[2];
if (!path) {
  process.stderr.write("usage: peak-rss-child.ts <hbc-path>\n");
  process.exit(2);
}
const bytes = new Uint8Array(readFileSync(path));
const r = splitProject(bytes, { moduleName: basename(path) });
if (r.files.size === 0) {
  process.stderr.write("split produced no files\n");
  process.exit(1);
}
// `process.resourceUsage().maxRSS` is the whole process's peak resident set
// size in kilobytes since start (getrusage `ru_maxrss`, normalised to KB by
// Node on every platform) -- exactly the number a `--max-old-space-size`
// budget needs, since RSS covers the V8 heap the flag bounds plus every
// native/external allocation (parse buffers, string data) the flag does not.
const usage = process.resourceUsage();
process.stdout.write(JSON.stringify({ maxRssKb: usage.maxRSS, fileCount: r.files.size }));
