// export-boot L4 (react-navigation B1): with --instrument=modules the
// registry flushed its 256-entry timing ring through console.log, i.e. a
// nativeLoggingHook call the original app never makes, so the boot proof
// diverged at the 256th module. Under the boot-proof probe host the probe
// already observes every factory; the timing ring must stay silent there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRegistryJs } from "../../../src/export/registry.ts";

function load(withProbe: boolean): { logs: string[]; probes: number } {
  const logs: string[] = [];
  let probes = 0;
  const g: Record<string, unknown> = { console: { log: (s: string) => logs.push(String(s)) } };
  if (withProbe) g.__HBC_BOOT_PROBE__ = () => void probes++;
  const mod = { exports: {} as Record<string, (...a: unknown[]) => unknown> };
  // The registry reads `globalThis` and `console`; give it a sandboxed pair.
  new Function("module", "exports", "require", "globalThis", "console", buildRegistryJs(new Map(), true))(mod, mod.exports, () => ({}), g, g.console);
  const reg = mod.exports;
  for (let id = 0; id < 300; id++) reg.define!(() => {}, id, []);
  for (let id = 0; id < 300; id++) reg.r!(id);
  return { logs, probes };
}

test("export-boot L4: the timing ring never logs while the boot-proof probe is present", () => {
  const { logs, probes } = load(true);
  assert.equal(probes, 600);
  assert.deepEqual(logs, []);
});

test("export-boot L4: without the probe (a device) the full ring still flushes through console.log", () => {
  const { logs } = load(false);
  assert.equal(logs.length, 256);
  assert.match(logs[0]!, /^__HBC_BOOT_TIMING__ /);
});
