// fixbatch3 a2 register boot (2026-11-25): the original side's Hermes VM was
// OOM-killed by the kernel (bare SIGKILL, no output) and `equiv --boot`
// reported "hermes produced no boot trace at all: " with an empty reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootVmMemoryMb, noTraceReason } from "../../../src/harness/boot-equiv.ts";
import { findAllHermesVms, runHermes } from "../../../src/harness/hermes-vm.ts";

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

// fix-boot-oom (2026-11-25): the boot VM now runs under an address-space cap
// (HBC2JS_BOOT_VM_MEMORY_MB, default 16 GiB), so a runaway compile or run
// aborts alone with the VM's own report, which the reason names.
test("boot no-trace reason names the memory limit when the VM ran out of memory", () => {
  const r = noTraceReason({ timedOut: false, status: 134, signal: null, stdout: "", stderr: "LLVM ERROR: out of memory\n" });
  assert.match(r, /ran out of memory \(VM cap \d+ MiB, HBC2JS_BOOT_VM_MEMORY_MB\)/);
});

test("boot VM memory cap: default 16384 MiB, env override, 0 = uncapped", () => {
  const saved = process.env.HBC2JS_BOOT_VM_MEMORY_MB;
  try {
    delete process.env.HBC2JS_BOOT_VM_MEMORY_MB;
    assert.equal(bootVmMemoryMb(), 16384);
    process.env.HBC2JS_BOOT_VM_MEMORY_MB = "512";
    assert.equal(bootVmMemoryMb(), 512);
    process.env.HBC2JS_BOOT_VM_MEMORY_MB = "0";
    assert.equal(bootVmMemoryMb(), 0);
  } finally {
    if (saved === undefined) delete process.env.HBC2JS_BOOT_VM_MEMORY_MB;
    else process.env.HBC2JS_BOOT_VM_MEMORY_MB = saved;
  }
});

test("runHermes under a memory cap: a run that outgrows it fails alone (Linux, with a VM)", { skip: process.platform !== "linux" || findAllHermesVms().length === 0 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-vmcap-"));
  try {
    const file = join(dir, "grow.js");
    writeFileSync(file, "var a = []; for (var i = 0; i < 1e9; i++) a.push({ i: i, s: 'x' + i }); print(a.length);\n");
    const r = runHermes(findAllHermesVms()[0]!.path, file, { timeout: 60000, quiet: true, memoryLimitMb: 3072 });
    assert.match(noTraceReason(r), /ran out of memory/);
    assert.equal(r.ok, false);
    assert.equal(r.timedOut, false);
    writeFileSync(join(dir, "ok.js"), "print(6 * 7);\n");
    const ok = runHermes(findAllHermesVms()[0]!.path, join(dir, "ok.js"), { timeout: 60000, quiet: true, memoryLimitMb: 3072 });
    assert.equal(ok.stdout.trim(), "42");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
