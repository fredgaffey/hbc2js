// The assertion is STRUCTURAL, not a stopwatch: it reads
// `ArtifactService.warmAnalyseCount` (already used by
// `tests/ui-server/warm-frames.test.ts`) at the instant the load-path
// request resolves. Blocked: the warm has already finished
// (`warmAnalyseCount === 1`) by the time the "fast" route answers, because
// the route's own response could only run after the synchronous pass gave
// the thread back. Fixed: the route answers while the warm is still in
// flight (`warmAnalyseCount === 0`), because the warm no longer monopolises
// the thread. Load-immune: this is an ordering fact, not a duration.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb } from "../../src/projdb/db.ts";
import { initProjectDb } from "../../src/projdb/ix-write.ts";
import { buildIndexRows } from "../../src/artifact/index-rows.ts";
import { writeSplitResult } from "../../src/split/write.ts";
import { startUiServer } from "../../src/ui-server/server.ts";
import { repoRoot } from "../support/paths.ts";
import { cachedSplitProject as splitProject } from "../support/decompiled.ts";

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");
const bytes = readFileSync(RN_TEMPLATE);

const outDir = mkdtempSync(join(tmpdir(), "hbc2js-first-paint-"));
{
  const splitResult = splitProject(bytes, { moduleName: "index.android.hbc" });
  writeSplitResult(splitResult, outDir);
  const rows = buildIndexRows({ bytes, splitResult, passes: {}, strictEnv: false, form: "flat" });
  const db = openProjectDb(join(outDir, "project.hbcproj"));
  try {
    initProjectDb(db, rows, { actorWho: "test" });
  } finally {
    db.close();
  }
}
test.after(() => rmSync(outDir, { recursive: true, force: true }));

test("a load-path route (/api/functions) answers without waiting for the cold-start whole-bundle warm", async () => {
  const h = await startUiServer({ projectDir: outDir, hbc: RN_TEMPLATE, port: 0, host: "127.0.0.1", workers: false, noAuth: true });
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const r = await fetch(`${base}/api/functions?limit=1`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as { rows: unknown[] };
    assert.ok(Array.isArray(body.rows), "the fixture must actually list functions, or this proves nothing");
    assert.equal(
      h.ctx.resources.artifact.warmAnalyseCount,
      0,
      "the load-path route only answered AFTER the whole-bundle cold-start warm finished -- " +
        "it was queued behind a computation its own answer never needed (docs/UI.md 'First paint' / 'Cold start')",
    );
  } finally {
    await h.close();
  }
});
