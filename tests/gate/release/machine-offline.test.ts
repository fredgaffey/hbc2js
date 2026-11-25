// The machine contract (spec 34: `--version --json`, `--info --json`,
// `modules --json`, `decompile --json`) is what external tool providers call
// (REA's hbc2js provider declares only "read files" and "launch a process").
// It must never be able to reach the network. Network-capable features
// (npm registry lookups in deps --confirm/guess, the OSV security gate, the
// Anthropic readability backend) live behind other commands. This test walks
// the static import graph from src/machine.ts and fails if any reachable
// module could open a connection. Raised on morluto/rea#7038 (2026-11-25).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { repoRoot } from "../../support/paths.ts";

const NETWORK = /\bfetch\(|registry\.npmjs|api\.osv\.dev|api\.anthropic\.com|["']node:(?:https?|net|tls|dgram|http2)["']|["'](?:https?|net|tls|dgram|http2)["']\s*\)/;
const IMPORT = /(?:import|export)[^"']*?from\s+["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']\s*\)|require\(\s*["'](\.[^"']+)["']\s*\)/g;

function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const f = stack.pop() as string;
    if (seen.has(f)) continue;
    let src: string;
    try {
      src = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    seen.add(f);
    for (const m of src.matchAll(IMPORT)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (spec !== undefined) stack.push(normalize(join(dirname(f), spec)));
    }
  }
  return seen;
}

test("machine contract (rea#7038): nothing reachable from src/machine.ts can open a network connection", () => {
  const root = repoRoot();
  const files = reachable(join(root, "src", "machine.ts"));
  assert.ok(files.size > 50, `import walk looks broken: only ${files.size} files reached`);
  const offenders = [...files].filter((f) => NETWORK.test(readFileSync(f, "utf8"))).map((f) => relative(root, f));
  assert.deepEqual(offenders, [], "network-capable modules reachable from the machine contract");
});

test("machine contract (rea#7038): the detector does flag the known network modules (guards against a dead regex)", () => {
  const root = repoRoot();
  for (const f of ["src/deps/guess.ts", "src/workers/backends/haiku.ts"]) {
    assert.ok(NETWORK.test(readFileSync(join(root, f), "utf8")), `${f} should match the network pattern`);
  }
});
