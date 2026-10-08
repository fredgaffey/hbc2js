import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, exportTo, IMPLEMENTED, RN_TEMPLATE, walk } from "./support.ts";

const SKIP = { skip: IMPLEMENTED ? false : "docs/specs/29-export.md not implemented yet" };
const REGISTRY_REL = join("src", "_hbc", "registry.js");

test("T7: --instrument=modules is OFF by default -- no wrapper, no ring buffer", SKIP, () => {
  const { out, run } = exportTo(RN_TEMPLATE);
  try {
    assert.equal(run.status, 0, `export failed: ${run.stderr}`);
    const registry = readFileSync(join(out, REGISTRY_REL), "utf8");
    assert.doesNotMatch(registry, /__HBC_BOOT_TIMING/, "plain export must not emit the boot-timing wrapper");
    assert.doesNotMatch(registry, /__HBC_BOOT_TIMINGS__/, "plain export must not emit the ring-buffer global");
  } finally {
    cleanup(out);
  }
});

test("T7: --instrument=modules wraps registry.js's factory call with a timer into a documented ring buffer", SKIP, () => {
  const { out, run } = exportTo(RN_TEMPLATE, ["--instrument=modules"]);
  try {
    assert.equal(run.status, 0, `export --instrument=modules failed: ${run.stderr}`);
    const registry = readFileSync(join(out, REGISTRY_REL), "utf8");

    // Ring buffer global: a real array on globalThis, named consistently.
    assert.match(registry, /globalThis\.__HBC_BOOT_TIMINGS__\s*=/, "no __HBC_BOOT_TIMINGS__ ring buffer global");
    // Monotonic clock with a documented Hermes/RN-safe fallback (never a
    // Node-only API assumed present in a bundled RN tree).
    assert.match(registry, /globalThis\.performance/, "no performance.now() clock branch");
    assert.match(registry, /Date\.now\(\)/, "no Date.now() fallback for a runtime without performance.now()");
    // Flush: console output carrying the {id,t0,dt} record, marker-prefixed
    // so a captured log stream (adb logcat / os_log, same convention as
    // the device tool's HBC2JS_DEVICE_MARKER lines) is greppable into a dump file.
    assert.match(registry, /__HBC_BOOT_TIMING__/, "no __HBC_BOOT_TIMING__ marker for the flushed record");
    assert.match(registry, /console\.log/, "flush does not go through console.log");

    // The timer must actually straddle the real factory call -- one clock
    // read, the unchanged `entry.factory(...)` call, another clock read --
    // never a rewritten/replaced factory invocation.
    const factoryCallAt = registry.indexOf("entry.factory(globalThis, requireFn, importDefault, importAll, mod, mod.exports, entry.deps);");
    assert.ok(factoryCallAt >= 0, "entry.factory(...) call site is unchanged (semantics must not move)");
    const beforeClockAt = registry.lastIndexOf("__hbc_now()", factoryCallAt);
    const afterClockAt = registry.indexOf("__hbc_now()", factoryCallAt + 1);
    assert.ok(beforeClockAt >= 0 && beforeClockAt < factoryCallAt, "no clock read before entry.factory(...)");
    assert.ok(afterClockAt > factoryCallAt, "no clock read after entry.factory(...)");

    // The pushed record has exactly the documented shape.
    assert.match(registry, /\{\s*id:\s*id,\s*t0:\s*[A-Za-z0-9_]+,\s*dt:\s*[A-Za-z0-9_]+\s*\}/, "ring buffer record is not {id, t0, dt}");

    execFileSync(process.execPath, ["--check", join(out, REGISTRY_REL)], { stdio: "pipe" });
  } finally {
    cleanup(out);
  }
});

test("T7: --instrument=modules changes nothing else in the exported tree", SKIP, () => {
  const plain = exportTo(RN_TEMPLATE);
  const instrumented = exportTo(RN_TEMPLATE, ["--instrument=modules"]);
  try {
    assert.equal(plain.run.status, 0, `plain export failed: ${plain.run.stderr}`);
    assert.equal(instrumented.run.status, 0, `instrumented export failed: ${instrumented.run.stderr}`);
    const plainFiles = walk(plain.out).sort();
    const instrumentedFiles = walk(instrumented.out).sort();
    assert.deepEqual(instrumentedFiles, plainFiles, "--instrument=modules must not add or remove any file");

    for (const f of plainFiles) {
      if (f === REGISTRY_REL.split("\\").join("/") || f === "EXPORT.json") continue;
      const a = readFileSync(join(plain.out, f), "utf8");
      const b = readFileSync(join(instrumented.out, f), "utf8");
      assert.equal(b, a, `--instrument=modules changed ${f}, which is not registry.js/EXPORT.json`);
    }

    // EXPORT.json: identical modulo the producer timestamp (both runs are
    // real invocations a few ms apart).
    const stripTs = (text: string): string => text.replace(/"ts":\s*"[^"]*"/, '"ts":"<ts>"');
    const manifestA = stripTs(readFileSync(join(plain.out, "EXPORT.json"), "utf8"));
    const manifestB = stripTs(readFileSync(join(instrumented.out, "EXPORT.json"), "utf8"));
    assert.equal(manifestB, manifestA, "--instrument=modules must not change EXPORT.json beyond its own timestamp");
  } finally {
    cleanup(plain.out);
    cleanup(instrumented.out);
  }
});

test("T7: hbc2js export rejects an unknown --instrument value", SKIP, () => {
  const { out, run } = exportTo(RN_TEMPLATE, ["--instrument=bogus"]);
  try {
    assert.notEqual(run.status, 0, "an unknown --instrument value must not succeed");
    assert.match(run.stderr, /--instrument/, "error message does not mention --instrument");
  } finally {
    cleanup(out);
  }
});
