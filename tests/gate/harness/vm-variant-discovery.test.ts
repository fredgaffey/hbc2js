// Toolchain VM v98: a v98 bundle is either "98-late" (class E, what every
// public hermes-compiler@250829098.0.x emits) or "98-early" (class D). The VM
// directory is picked from the opcode table the layout probe chose.
// Pure function; no binary needed.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { hermesVmKey, hermesVmCandidates } from "../../../src/harness/hermes-vm.ts";

test("hermesVmKey: v98-late and v98-early map to different VM dirs", () => {
  assert.equal(hermesVmKey(98, "hbc98-late"), "98");
  assert.equal(hermesVmKey(98, "hbc98-2024"), "98-early");
  assert.equal(hermesVmKey(98, undefined), "98");
  assert.equal(hermesVmKey(99, "hbc99-mar2026"), "99");
  assert.equal(hermesVmKey(94, "hbc94"), "94");
});

test("hermesVmCandidates: v98-early probes tools/hermes-vm/v98-early/bin/hermes first", () => {
  const early = hermesVmCandidates(98, "hbc98-2024").map((p) => p.split(path.sep).slice(-4).join("/"));
  assert.equal(early[0], "hermes-vm/v98-early/bin/hermes");
  const late = hermesVmCandidates(98, "hbc98-late").map((p) => p.split(path.sep).slice(-4).join("/"));
  assert.equal(late[0], "hermes-vm/v98/bin/hermes");
});
