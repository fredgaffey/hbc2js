// 0.1.2 benchmark finding: `hbc2js setup-vm 98|99` installed hermesc only and
// said nothing, so `equiv --boot` later found no VM. No prebuilt Hermes VM
// exists for v98/v99 (tools/get-hermesc.sh header lists what each source
// ships); setup-vm must say so and point at tools/build-hermes-vm.sh.
// Offline: a pre-populated cache makes the script skip every download.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";

const CLI = join(repoRoot(), "src", "cli.ts");

function fakeCache(files: Record<string, string[]>): string {
  const xdg = mkdtempSync(join(tmpdir(), "hbc2js-setup-vm-"));
  for (const [v, names] of Object.entries(files)) {
    const d = join(xdg, "hbc2js", "hermesc", v);
    mkdirSync(d, { recursive: true });
    for (const n of names) {
      writeFileSync(join(d, n), "#!/bin/sh\nexit 0\n");
      chmodSync(join(d, n), 0o755);
    }
  }
  return xdg;
}

function setupVm(xdg: string, v: string) {
  return spawnSync(process.execPath, [CLI, "setup-vm", v], { encoding: "utf8", env: { ...process.env, XDG_CACHE_HOME: xdg } });
}

test("setup-vm 98: no prebuilt VM is said clearly, with the source-build route and the v96 source-mode route", () => {
  const r = setupVm(fakeCache({ v98: ["hermesc"] }), "98");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /no prebuilt Hermes VM \(the 'hermes' CLI\) exists for HBC v98/);
  assert.match(r.stderr, /tools\/build-hermes-vm\.sh 98/);
  assert.match(r.stderr, /setup-vm 96/);
});

test("setup-vm 96 with a VM already installed prints no note", () => {
  const r = setupVm(fakeCache({ v96: ["hermesc", "hermes"] }), "96");
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /no prebuilt/);
});
