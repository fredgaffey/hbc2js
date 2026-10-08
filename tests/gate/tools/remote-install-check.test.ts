// docs/REMOTE-CI.md "What a job does" step 4 — a compute-node job must fail
// loudly if the install step (root or ui/) silently produced no
// node_modules, instead of proceeding to a confusing failure deep inside
// `npm run typecheck` output (a deployed
// server.mjs that predated the ui/ install loop, so ui/ install never ran and
// the job "succeeded" through setup before failing on
// `Cannot find module '@dagrejs/dagre'`). tools/remote/install-check.mjs is
// the pure check the job runner calls after its install loop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findBrokenInstalls, installCheckError } from "../../../tools/remote/install-check.mjs";

test("findBrokenInstalls: all installs fine -> nothing broken", () => {
  const broken = findBrokenInstalls([
    { label: "npm ci", hasLock: true, hasNodeModules: true },
    { label: "npm ci (ui/)", hasLock: true, hasNodeModules: true },
  ]);
  assert.deepEqual(broken, []);
});

test("findBrokenInstalls: ui/ has a lockfile but no node_modules -> flagged", () => {
  const broken = findBrokenInstalls([
    { label: "npm ci", hasLock: true, hasNodeModules: true },
    { label: "npm ci (ui/)", hasLock: true, hasNodeModules: false },
  ]);
  assert.deepEqual(broken, ["npm ci (ui/)"]);
});

test("findBrokenInstalls: no lockfile is not broken (legitimately skipped)", () => {
  const broken = findBrokenInstalls([
    { label: "npm ci (ui/)", hasLock: false, hasNodeModules: false },
  ]);
  assert.deepEqual(broken, []);
});

test("installCheckError: null when nothing broken, actionable message otherwise", () => {
  assert.equal(installCheckError([]), null);
  const msg = installCheckError(["npm ci (ui/)"]);
  assert.ok(msg);
  assert.match(msg, /npm ci \(ui\/\)/);
  assert.match(msg, /tools\/remote\/install\.sh/);
});
