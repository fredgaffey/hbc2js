// Uses the committed rn-template-0.72/truth fixture (unlike the
// react-navigation-example-0.85.3 one, its .hbc + truth.json are checked
// in) so this runs in the gate tier without any local fetch.sh step, by
// deliberately corrupting an in-memory copy of the truth's pinned sha to
// force a mismatch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
// @ts-expect-error — plain-JS tool, no declaration file.
import { scoreAgainstTruth, shaGuardMessage } from "../../../tools/deps-truth.mjs";

const TRUTH_DIR = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "truth");
const truth = JSON.parse(readFileSync(join(TRUTH_DIR, "deps-truth.json"), "utf8"));

test("shaGuardMessage: null on a matching sha", async () => {
  const s = await scoreAgainstTruth(join(TRUTH_DIR, "index.android.hbc"), truth);
  assert.equal(s.hbcSha256Matches, true);
  assert.equal(shaGuardMessage(s, "deps-truth.json"), null);
});

test("shaGuardMessage: actionable message naming the file and BUILD.md on a mismatch", async () => {
  const corrupted = { ...truth, hbcSha256s: { "index.android.hbc": "0".repeat(64), "index.android.debug.hbc": "0".repeat(64) } };
  const s = await scoreAgainstTruth(join(TRUTH_DIR, "index.android.hbc"), corrupted);
  assert.equal(s.hbcSha256Matches, false);
  const msg = shaGuardMessage(s, "tests/fixtures/bundles/rn-template-0.72/truth/deps-truth.json");
  assert.ok(msg !== null);
  assert.match(msg as string, /index\.android\.hbc/);
  assert.match(msg as string, /BUILD\.md/);
  assert.match(msg as string, /fetch\.sh/);
  assert.match(msg as string, /re-pin/);
});
