// A wedged child process (e.g. a hermesc blocked on stdin) once hung the gate for 43 minutes.
// Guards: every test entry point preloads the default-timeout shim and sets --test-timeout, and
// the shim really kills a hung synchronous child.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";

const root = repoRoot();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };

test("every package.json script that runs node --test preloads the timeout shim and sets --test-timeout", () => {
  const offenders: string[] = [];
  for (const [name, cmd] of Object.entries(pkg.scripts)) {
    for (const part of cmd.split("&&")) {
      if (!/node\s+(?:\S+\s+)*--test\b/.test(part)) continue;
      if (!part.includes("--import ./tools/test/default-timeouts.mjs") || !/--test-timeout=\d+/.test(part)) offenders.push(`${name}: ${part.trim().slice(0, 60)}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("tools/run-tests.mjs passes the shim and --test-timeout to node --test", () => {
  const src = readFileSync(join(root, "tools", "run-tests.mjs"), "utf8");
  assert.match(src, /default-timeouts\.mjs/);
  assert.match(src, /--test-timeout=/);
});

test("the shim kills a synchronous child that has no explicit timeout", () => {
  const code = `import { spawnSync, execFileSync } from "node:child_process";
    const a = spawnSync("sleep", ["30"]);
    let b = "none"; try { execFileSync("sleep", ["30"]); } catch (e) { b = e.code; }
    console.log(JSON.stringify({ a: a.error?.code, sig: a.signal, b }));`;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ["--import", join(root, "tools", "test", "default-timeouts.mjs"), "--input-type=module", "-e", code], {
    encoding: "utf8", timeout: 30_000, env: { ...process.env, HBC2JS_SYNC_CHILD_TIMEOUT_MS: "400" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { a: "ETIMEDOUT", sig: "SIGKILL", b: "ETIMEDOUT" });
  assert.ok(Date.now() - t0 < 20_000);
});

test("an explicit timeout is respected", () => {
  const code = `import { spawnSync } from "node:child_process";
    const a = spawnSync("sleep", ["30"], { timeout: 300, killSignal: "SIGTERM" }); console.log(a.signal);`;
  const r = spawnSync(process.execPath, ["--import", join(root, "tools", "test", "default-timeouts.mjs"), "--input-type=module", "-e", code], {
    encoding: "utf8", timeout: 30_000, env: { ...process.env, HBC2JS_SYNC_CHILD_TIMEOUT_MS: "5000" },
  });
  assert.equal(r.stdout.trim(), "SIGTERM");
});
