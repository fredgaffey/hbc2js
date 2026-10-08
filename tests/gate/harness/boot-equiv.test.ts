// docs/specs/31-equiv-boot.md section 7 — the acceptance checklist for
// `equiv --boot` turned into gate tests (T8b). Driven in-process against
// `src/harness/boot-equiv.ts`; the CLI-level exit-code checks (criterion 7)
// live in cli.test.ts alongside the rest of the `equiv` family.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { repoRoot } from "../../support/paths.ts";
import { requireOracles, requireSweep } from "../../support/tiers.ts";
import { findAllHermesVms } from "../../../src/harness/hermes-vm.ts";
import { TRACE_VERDICT } from "../../../src/harness/compare.ts";
import { DEFAULT_FIRST_NATIVE, acquireBootSource, bootTrace, compareBootTraces } from "../../../src/harness/boot-equiv.ts";
import type { CallRecord } from "../../../src/harness/trace.ts";

/** The boot oracle runs entirely in SOURCE mode (spec 31 section 1), so
 *  *any* discovered Hermes VM works regardless of its own HBC version --
 *  unlike `equiv --hbc`'s `vmOrSkip`, this never needs a version match. */
function vmOrSkip(t: TestContext): boolean {
  if (findAllHermesVms().length > 0) return true;
  const msg = "no Hermes VM discovered anywhere (tools/hermesc/v<N>/hermes); the equiv --boot oracle cannot run";
  if (requireOracles()) throw new Error(msg);
  t.skip(msg);
  return false;
}

function inTempFile<T>(name: string, content: string, fn: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-boot-equiv-test-"));
  try {
    const p = join(dir, name);
    writeFileSync(p, content);
    return fn(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const RN_TEMPLATE_BUNDLE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.bundle");
const HELD_OUT_BUNDLE = join(repoRoot(), "tests", "fixtures", "bundles", "react-navigation-example-0.85.3", "index.android.bundle");

function isCall(r: { readonly k: string }): r is CallRecord {
  return r.k === "call";
}

// --- criterion 1: rn-template reaches end-of-IIFE under the stub host -----

test("bootTrace: rn-template reaches end-of-IIFE under the stub host (spec 31 section 7.1)", (t) => {
  if (!vmOrSkip(t)) return;
  const src = readFileSync(RN_TEMPLATE_BUNDLE, "utf8");
  const r = bootTrace(src, { seed: 0 });
  assert.equal(r.ran, true, r.why ?? "");
  assert.equal(r.bootError, null, `boot threw: ${JSON.stringify(r.bootError)}`);
  assert.equal(r.reachedEnd, true, "expected an EndRecord");
  assert.ok(r.trace.records.some((rec) => rec.k === "end"));
  assert.ok(r.trace.records.some((rec) => isCall(rec) && rec.fn === "__d"), "expected at least one __d registration");
  assert.ok(r.trace.records.some((rec) => isCall(rec) && rec.fn === "__r"), "expected at least one __r require");
  assert.ok(r.trace.records.some((rec) => isCall(rec) && rec.fn !== "__d" && rec.fn !== "__r"), "expected at least one native interaction");
});

// --- criterion 2: the held-out app (v98) at sweep tier ---------------------

test("sweep: the held-out app (v98) boots under the stub host, or is honestly INCONCLUSIVE (spec 31 section 7.2, section 4.2)", (t) => {
  if (!requireSweep(t)) return;
  if (!existsSync(HELD_OUT_BUNDLE)) {
    t.skip(`${HELD_OUT_BUNDLE} not present; run its fetch.sh (network) first`);
    return;
  }
  if (!vmOrSkip(t)) return;
  const src = readFileSync(HELD_OUT_BUNDLE, "utf8");
  const r = bootTrace(src, { seed: 0, timeoutMs: 30000 });
  if (r.reachedEnd) {
    assert.equal(r.bootError, null);
    return;
  }
  assert.equal(r.ran, false, `expected a parse-time failure, not a runtime boot error: ${JSON.stringify(r.bootError)}`);
  const cmp = compareBootTraces(r, bootTrace(src, { seed: 0, timeoutMs: 30000 }));
  assert.equal(cmp.verdict, TRACE_VERDICT.INCONCLUSIVE);
});

// --- criterion 3: a known-equivalent pair (a bundle vs itself) -------------

test("compareBootTraces: rn-template vs itself is EQUIVALENT (spec 31 section 7.3)", (t) => {
  if (!vmOrSkip(t)) return;
  const src = readFileSync(RN_TEMPLATE_BUNDLE, "utf8");
  const a = bootTrace(src, { seed: 0 });
  const b = bootTrace(src, { seed: 0 });
  const cmp = compareBootTraces(a, b);
  assert.equal(cmp.verdict, TRACE_VERDICT.EQUIVALENT, cmp.why);
  assert.equal(cmp.cmp?.divergence ?? null, null);
});

// --- criterion 4: an intentionally divergent pair is caught at the first --
// divergence, with both sides' context.

const TOY_METRO_RUNTIME = `
(function (g) {
  var reg = {};
  g.__d = function (factory, id, deps) { reg[id] = { factory: factory, deps: deps }; };
  g.__r = function (id) { return reg[id].factory(g, g.__r); };
})(this);
`;

test("compareBootTraces: a reordered __d registration is caught at the first divergence (spec 31 section 7.4)", (t) => {
  if (!vmOrSkip(t)) return;
  const a = `${TOY_METRO_RUNTIME}__d(function () { return 1; }, 1, []);\n__d(function () { return 2; }, 2, []);\n__r(1);\n__r(2);\n`;
  const b = `${TOY_METRO_RUNTIME}__d(function () { return 2; }, 2, []);\n__d(function () { return 1; }, 1, []);\n__r(1);\n__r(2);\n`;
  const ta = bootTrace(a, { seed: 0 });
  const tb = bootTrace(b, { seed: 0 });
  assert.equal(ta.reachedEnd, true, JSON.stringify(ta.bootError));
  assert.equal(tb.reachedEnd, true, JSON.stringify(tb.bootError));
  const cmp = compareBootTraces(ta, tb);
  assert.equal(cmp.verdict, TRACE_VERDICT.DIVERGENT, cmp.why);
  assert.notEqual(cmp.cmp, null);
  const divergence = cmp.cmp!.divergence;
  assert.notEqual(divergence, null);
  assert.match(divergence!.a, /__d\(1,/);
  assert.match(divergence!.b, /__d\(2,/);
  assert.notEqual(cmp.cmp!.context, null);
  assert.match(cmp.cmp!.context!, /__d\(1,/);
  assert.match(cmp.cmp!.context!, /__d\(2,/);
});

// --- criterion 5: a side that cannot boot is INCONCLUSIVE, never PASS and -
// never a spurious DIVERGENT.

test("compareBootTraces: a side that throws before EndRecord is INCONCLUSIVE, never EQUIVALENT or DIVERGENT (spec 31 section 7.5)", (t) => {
  if (!vmOrSkip(t)) return;
  const ok = bootTrace('nativeLoggingHook("hi", 1);', { seed: 0 });
  const broken = bootTrace("throw new Error('boom');", { seed: 0 });
  assert.equal(ok.reachedEnd, true);
  assert.equal(broken.reachedEnd, false);
  assert.deepEqual(broken.bootError, { name: "Error", message: "boom" });
  const cmp = compareBootTraces(ok, broken);
  assert.equal(cmp.verdict, TRACE_VERDICT.INCONCLUSIVE, cmp.why);
  assert.notEqual(cmp.verdict, TRACE_VERDICT.EQUIVALENT);
  assert.notEqual(cmp.verdict, TRACE_VERDICT.DIVERGENT);
  assert.equal(cmp.cmp, null, "a boot-gap side must short-circuit before ever calling compareTraces");
});

// --- criterion 6: --first-native N bounds the trace ------------------------

test("bootTrace: firstNative caps recorded native interactions but not __d/__r (spec 31 section 7.6)", (t) => {
  if (!vmOrSkip(t)) return;
  let src = "";
  for (let i = 0; i < 20; i++) src += "nativeCallSyncHook();\n";
  src += `${TOY_METRO_RUNTIME}__d(function () { return 1; }, 1, []);\n__r(1);\n`;
  const r = bootTrace(src, { seed: 0, firstNative: 5 });
  assert.equal(r.reachedEnd, true, JSON.stringify(r.bootError));
  const nativeCalls = r.trace.records.filter((rec) => isCall(rec) && rec.fn === "nativeCallSyncHook");
  const limits = r.trace.records.filter((rec) => rec.k === "limit");
  assert.equal(nativeCalls.length, 5);
  assert.equal(limits.length, 1);
  assert.equal((limits[0] as { why: string }).why, "first-native");
  assert.equal(r.trace.records.filter((rec) => isCall(rec) && rec.fn === "__d").length, 1);
  assert.equal(r.trace.records.filter((rec) => isCall(rec) && rec.fn === "__r").length, 1);
});

test("bootTrace: DEFAULT_FIRST_NATIVE is 64, per spec 31 section 3", () => {
  assert.equal(DEFAULT_FIRST_NATIVE, 64);
});

// --- acquireBootSource: source acquisition (spec 31 section 8) ------------

test("acquireBootSource: a .js/.bundle input passes through unchanged as bundle-js", () => {
  const r = inTempFile("x.js", 'print("hi");', (p) => acquireBootSource(p));
  assert.equal(r.sourceKind, "bundle-js");
  assert.equal(r.source, 'print("hi");');
});

test("acquireBootSource: a .hbc input is decompiled and flagged decompiled", () => {
  const hbc = join(repoRoot(), "tests", "fixtures", "constructs", "04-for-loop-basic", "v84.hbc");
  if (!existsSync(hbc)) return;
  const r = acquireBootSource(hbc);
  assert.equal(r.sourceKind, "decompiled");
  assert.ok(r.source.length > 0);
});
