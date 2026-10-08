// BUILDONE1: tools/pkgsig/bulk/build-one.mjs must install peer dependencies
// (strict install first, --legacy-peer-deps only as fallback, like
// src/deps/confirm.ts installCandidate) and must not hit ENOBUFS on large
// hermesc/metro stderr. Offline: only the pure plan is exercised.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
// @ts-expect-error untyped .mjs
import { installAttempts, MAX_BUFFER, pipedOpts, runInstall } from "../../../tools/pkgsig/bulk/install-plan.mjs";

test("BUILDONE1: first install attempt is strict (no --legacy-peer-deps), fallback has it", () => {
  const [a, b] = installAttempts("@react-navigation/stack@6.4.1") as [string[], string[]];
  assert.ok(!a.includes("--legacy-peer-deps"));
  assert.ok(a.includes("--ignore-scripts") && a.includes("--no-save"));
  assert.ok(b.includes("--legacy-peer-deps") && b.includes("--ignore-scripts"));
});

test("BUILDONE1: runInstall falls back only when strict fails", () => {
  const calls: string[][] = [];
  assert.equal(runInstall("x@1", (_c: string, a: string[]) => { calls.push(a); }), 0);
  assert.equal(calls.length, 1);
  const calls2: string[][] = [];
  assert.equal(runInstall("x@1", (_c: string, a: string[]) => { calls2.push(a); if (calls2.length === 1) throw new Error("ERESOLVE"); }), 1);
  assert.ok(calls2[1]!.includes("--legacy-peer-deps"));
  assert.throws(() => runInstall("x@1", () => { throw new Error("boom"); }), /boom/);
});

test("BUILDONE1: piped children get a large maxBuffer (axios ENOBUFS)", () => {
  assert.ok(MAX_BUFFER >= 1 << 28);
  assert.equal(pipedOpts({ timeout: 5 }).maxBuffer, MAX_BUFFER);
  assert.equal(pipedOpts({ timeout: 5 }).timeout, 5);
});

test("BUILDONE1: build-one.mjs uses the plan (no inline --legacy-peer-deps, no unbuffered pipes)", () => {
  const src = readFileSync(new URL("../../../tools/pkgsig/bulk/build-one.mjs", import.meta.url), "utf8");
  assert.ok(/runInstall\(/.test(src));
  assert.ok(!/"--legacy-peer-deps"/.test(src));
  assert.ok(!/stdio: \["ignore", "ignore", "pipe"\]/.test(src));
});
