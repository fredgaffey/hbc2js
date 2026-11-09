// Toolchain: the v99 VM must be at least as new as the public v99 hermesc.
// The public hermes-compiler@260318099.0.x lowers computed method/class names
// to `CallBuiltin HermesBuiltin.setFunctionName`; a VM built from a commit that
// predates that builtin dies with "Can't apply() to non-callable", which made
// T2 equivalence at v99 silently unable to cover those fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { findHermesVm, runHermes } from "../../../src/harness/hermes-vm.ts";
import { repoRoot } from "../../../src/util/paths.ts";

test("v99 VM executes public-hermesc bytecode that uses HermesBuiltin.setFunctionName", (t) => {
  const vm = findHermesVm(99);
  const hermesc = path.join(repoRoot(), "tools", "hermesc", "v99", "hermesc");
  if (vm === null || !existsSync(hermesc)) return t.skip("no v99 VM or hermesc");
  const dir = mkdtempSync(path.join(tmpdir(), "vm99-"));
  try {
    const src = path.join(dir, "a.js");
    const out = path.join(dir, "a.hbc");
    writeFileSync(src, 'var k = "dyn" + "name"; class C { [k]() {} static get [k + "2"]() { return 1; } }\nprint(C.prototype[k].name, Object.getOwnPropertyDescriptor(C, k + "2").get.name);\n');
    execFileSync(hermesc, ["-emit-binary", `-out=${out}`, src]);
    const r = runHermes(vm.path, out);
    assert.ok(r.ok, r.raw);
    assert.deepEqual(r.lines, ["dynname get dynname2"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
