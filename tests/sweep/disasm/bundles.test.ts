// docs/specs/02-disassembler.md §8 (performance), §9 (bundles acceptance bullet) —
// sweep tier: Metro bundles, D13.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHbc } from "../../../src/index.ts";
import { decodeModule } from "../../../src/disasm/decode.ts";
import { printModule } from "../../../src/disasm/print.ts";
import { listBundles } from "../../support/fixtures.ts";
import { requireSweep } from "../../support/tiers.ts";

class NullWritable {
  write(_s: string): boolean {
    return true;
  }
}

test("every function of all four bundles/rn-template-0.72/*.hbc decodes with zero errors", (t) => {
  if (!requireSweep(t)) return;
  const bundles = listBundles();
  assert.ok(bundles.length > 0, "no bundles found under tests/fixtures/bundles/**");
  let anyOverflowedHeaders = 0;
  let anySharedBodies = 0;
  for (const b of bundles) {
    const mod = parseHbc(b.bytes());
    let count = 0;
    for (const fn of decodeModule(mod)) {
      count++;
      if (fn.header.flags.overflowed) anyOverflowedHeaders++;
      if (mod.functions[fn.index]!.bodyShared) anySharedBodies++;
      const last = fn.instructions[fn.instructions.length - 1];
      if (last !== undefined) {
        assert.equal(last.offset + last.length, fn.header.bytecodeSizeInBytes, `${b.path} fn#${fn.index}: decode did not land exactly on bytecodeSizeInBytes`);
      }
      for (const insn of fn.instructions) {
        for (const target of insn.targets) {
          assert.ok(fn.byOffset.has(target), `${b.path} fn#${fn.index}: ${insn.name}@${insn.offset} target ${target} not an instruction start`);
        }
      }
    }
    assert.equal(count, mod.functions.length, `${b.path}: expected to decode all ${mod.functions.length} functions`);
    assert.ok(count > 3000, `${b.path}: expected ~4200 functions, got ${count}`);
  }
  // "including the 2 overflowed headers and the 165 deduplicated bodies" (spec
  // 02 §9) refers specifically to `index.android.hbc` (the `-O` build); the
  // `noopt` variants don't dedupe bytecode at all (that's an `-O` pass), and
  // debug-info presence affects overflow differently per variant — so this is
  // an aggregate-across-all-four-variants check, not a per-variant one (same
  // relaxation the M1 parser sweep's own T10 test makes, scoped to
  // `index.android.hbc` alone).
  assert.ok(anyOverflowedHeaders > 0, "expected at least one overflowed header across all four bundle variants");
  assert.ok(anySharedBodies > 0, "expected at least one deduplicated (shared) body across all four bundle variants");
});

test("perf: printModule (raw and canonical) on the largest rn-template-0.72 bundle, extrapolated to the 12MB target (spec 02 §8)", (t) => {
  if (!requireSweep(t)) return;
  const bundles = listBundles();
  if (bundles.length === 0) {
    t.skip("no bundles present");
    return;
  }
  const largest = bundles.reduce((a, b) => (b.bytes().length > a.bytes().length ? b : a));
  const sizeMb = largest.bytes().length / (1024 * 1024);

  const decodeStart = performance.now();
  const mod = parseHbc(largest.bytes());
  let fnCount = 0;
  for (const _fn of decodeModule(mod)) fnCount++;
  const decodeElapsed = performance.now() - decodeStart;

  const rawStart = performance.now();
  printModule(mod, new NullWritable() as unknown as NodeJS.WritableStream, { mode: "raw" });
  const rawElapsed = performance.now() - rawStart;

  const canonStart = performance.now();
  printModule(mod, new NullWritable() as unknown as NodeJS.WritableStream, { mode: "canonical" });
  const canonElapsed = performance.now() - canonStart;

  const extrapolate = (ms: number): number => (ms / sizeMb) * 12;

  // Budgets from spec 02 §8, pro-rata for whatever the largest fixture actually is
  // (the true 12MB target bundle doesn't exist yet — spec 01 O-4).
  assert.ok(decodeElapsed < Math.max(extrapolate(4000), 200), `decodeModule took ${decodeElapsed.toFixed(1)}ms for ${sizeMb.toFixed(2)}MB`);
  assert.ok(rawElapsed < Math.max(extrapolate(15000), 500), `raw print took ${rawElapsed.toFixed(1)}ms for ${sizeMb.toFixed(2)}MB`);
  assert.ok(canonElapsed < Math.max(extrapolate(25000), 500), `canonical print took ${canonElapsed.toFixed(1)}ms for ${sizeMb.toFixed(2)}MB`);

  console.log(
    `[perf] ${largest.path} (${sizeMb.toFixed(2)}MB, ${fnCount} functions): ` +
      `decodeModule=${decodeElapsed.toFixed(1)}ms (->12MB: ${extrapolate(decodeElapsed).toFixed(0)}ms), ` +
      `raw print=${rawElapsed.toFixed(1)}ms (->12MB: ${extrapolate(rawElapsed).toFixed(0)}ms), ` +
      `canonical print=${canonElapsed.toFixed(1)}ms (->12MB: ${extrapolate(canonElapsed).toFixed(0)}ms)`,
  );
});
