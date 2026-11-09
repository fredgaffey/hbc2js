// `npm test -- <paths>` must run only the named files (it used to append the
// args to the last `node --test` of an `&&` chain, so the full gate still ran).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";

function plan(args: readonly string[]): string[] {
  const r = spawnSync(process.execPath, [join(repoRoot(), "tools", "run-tests.mjs"), ...args], {
    encoding: "utf8", env: { ...process.env, HBC2JS_RUN_TESTS_DRY: "1" },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split("\n");
}

test("run-tests: path arguments select exactly those files (no typecheck, no full gate)", () => {
  const p = plan(["tests/gate/docs/test-count.test.ts"]);
  assert.deepEqual(p, ["node --test tests/gate/docs/test-count.test.ts"]);
});

test("run-tests: no arguments runs typecheck, the full gate, then the e2e smoke file", () => {
  const p = plan([]);
  assert.equal(p.length, 3);
  assert.match(p[0]!, /typecheck/);
  assert.match(p[1]!, /tests\/gate\/\*\*\/\*\.test\.ts/);
  assert.match(p[2]!, /e2e-smoke/);
});
