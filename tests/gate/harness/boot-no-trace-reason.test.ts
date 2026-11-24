// fixbatch3 a2 register boot (2026-11-25): the original side's Hermes VM was
// OOM-killed by the kernel (bare SIGKILL, no output) and `equiv --boot`
// reported "hermes produced no boot trace at all: " with an empty reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import { noTraceReason } from "../../../src/harness/boot-equiv.ts";

test("boot no-trace reason names a kill signal and never ends empty", () => {
  const r = noTraceReason({ timedOut: false, status: null, signal: "SIGKILL", stdout: "", stderr: "" });
  assert.match(r, /killed by SIGKILL/);
  assert.match(r, /out of memory/);
  assert.match(r, /no output/);
});

test("boot no-trace reason reports timeout, exit status and the output tail", () => {
  assert.match(noTraceReason({ timedOut: true, stdout: "", stderr: "" }), /^timed out; no output$/);
  const r = noTraceReason({ timedOut: false, status: 2, signal: null, stdout: "", stderr: "x".repeat(1000) + "SyntaxError: bad" });
  assert.match(r, /exit status 2/);
  assert.match(r, /SyntaxError: bad$/);
  assert.ok(r.length < 500);
});
