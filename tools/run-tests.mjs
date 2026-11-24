#!/usr/bin/env node
// `npm test` entry. With no arguments: typecheck, then the full gate (the
// same file set `test:gate` runs) and the deferred UI e2e smoke file.
// With path/glob arguments (`npm test -- tests/gate/foo.test.ts`): run ONLY
// those files under `node --test` (no typecheck, no e2e smoke) -- npm used to
// append the arguments to the last `node --test` in the `&&` chain, so the full
// gate still ran. Flags starting with `-` are passed through to `node --test`.
import { spawnSync } from "node:child_process";

// Hang guards: --test-timeout fails any single test after 10 min (slowest legit file ~200s under
// load); the preload gives every sync child_process call a default timeout.
const NODE_FLAGS = ["--import", "./tools/test/default-timeouts.mjs", "--test-timeout=600000"];

const GATE_GLOBS = [
  "tests/gate/**/*.test.ts", "tests/artifact/**/*.test.ts", "tests/project/**/*.test.ts",
  "tests/projdb/**/*.test.ts", "tests/secrets/**/*.test.ts", "tests/security/**/*.test.ts",
  "tests/appgen/**/*.test.ts", "tests/mcp/**/*.test.ts", "tests/readability/**/*.test.ts",
  "tests/workers/**/*.test.ts", "tests/ui-core/**/*.test.ts", "tests/ui-server/**/*.test.ts",
  "tests/fuzz/spec-consistency.test.ts", "tests/cli/**/*.test.ts",
];

function run(cmd, args, env) {
  const r = spawnSync(cmd, args, { stdio: "inherit", env: { ...process.env, ...env } });
  return r.status ?? 1;
}

const args = process.argv.slice(2);
// Test hook: print the plan instead of running it.
const dry = process.env.HBC2JS_RUN_TESTS_DRY === "1";
const plan = args.length > 0
  ? [[process.execPath, [...NODE_FLAGS, "--test", ...args], { HBC2JS_E2E_DEFER: "1" }]]
  : [
      ["npm", ["run", "typecheck"], {}],
      [process.execPath, [...NODE_FLAGS, "--test", ...GATE_GLOBS], { HBC2JS_E2E_DEFER: "1" }],
      [process.execPath, [...NODE_FLAGS, "--test", "tests/gate/ui/e2e-smoke.test.ts"], {}],
    ];
if (dry) {
  for (const [cmd, a] of plan) console.log([cmd === process.execPath ? "node" : cmd, ...a].join(" "));
  process.exit(0);
}
for (const [cmd, a, env] of plan) {
  const s = run(cmd, a, env);
  if (s !== 0) process.exit(s);
}
