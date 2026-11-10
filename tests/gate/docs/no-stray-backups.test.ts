// Doc gate: no tracked file under docs/ may be an editor/sed/patch leftover
// (`*-e` from BSD `sed -i`, `.orig`, `.bak`, `.rej`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { repoRoot } from "../../support/paths.ts";

test("no tracked backup/patch leftovers under docs/", () => {
  const files = execFileSync("git", ["ls-files", "docs"], { cwd: repoRoot(), encoding: "utf8" }).split("\n").filter(Boolean);
  const bad = files.filter((f) => /(-e|\.orig|\.bak|\.rej)$/.test(f));
  assert.deepEqual(bad, []);
});
