// tests/ui-server/migrate-on-open.test.ts — docs/BUGS.md 2026-09-18
// `ix_module_dep_kind` row: `hbc2js ui-server <project>` on an existing
// `project.hbcproj` written before MIGRATION 7 used to die at startup with
// `no such table: ix_module_dep_kind` — `startUiServer` constructed
// `McpContext` (which opens the DB read-only, and a read-only connection
// cannot `ALTER TABLE`) BEFORE opening its own read-write connection (the
// one that runs `migrateProjectDb`, `src/projdb/db.ts`). Builds a project
// the same way `hbc2js init` does, then downgrades it exactly the way the
// bug report describes — drop the migration-7 table, reset
// `meta.schema_minor` — and starts a REAL `startUiServer` against it, the
// same function `src/cli.ts ui-server` calls. Fails before the fix (the
// `/api/modules` route 500s with the raw SQLite "no such table" message),
// passes after (the server starts and the route answers normally).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openProjectDb } from "../../src/projdb/db.ts";
import { initProjectDb } from "../../src/projdb/ix-write.ts";
import { buildIndexRows } from "../../src/artifact/index-rows.ts";
import { splitProject } from "../../src/split/index.ts";
import { writeSplitResult } from "../../src/split/write.ts";
import { repoRoot } from "../support/paths.ts";
import { startUiServer } from "../../src/ui-server/server.ts";

const FIXTURE_HBC = join(repoRoot(), "tests", "fixtures", "constructs", "04-for-loop-basic", "v96.hbc");
const bytes = readFileSync(FIXTURE_HBC);

/** Builds a current-schema project (mirrors `hbc2js init`'s layout: split
 *  tree at `<outDir>/src`, `project.hbcproj` at the root), then downgrades
 *  it to schema_minor 6 by dropping `ix_module_dep_kind` (the MIGRATION 7
 *  table) and resetting `meta.schema_minor` back to 6 — the exact
 *  reproduction the bug report names, done to a project this build itself
 *  produced rather than a hand-built old-DDL fixture. */
function buildDowngradedProject(): string {
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-ui-migrate-on-open-"));
  const splitResult = splitProject(bytes, { moduleName: "04-for-loop-basic" });
  writeSplitResult(splitResult, join(outDir, "src"));
  const rows = buildIndexRows({ bytes, splitResult, passes: {}, strictEnv: false, form: "flat" });
  const dbPathStr = join(outDir, "project.hbcproj");
  const db = openProjectDb(dbPathStr);
  try {
    initProjectDb(db, rows, { actorWho: "test" });
  } finally {
    db.close();
  }
  const downgrade = new DatabaseSync(dbPathStr);
  try {
    downgrade.exec("DROP TABLE ix_module_dep_kind;");
    downgrade.prepare("UPDATE meta SET value = ? WHERE key = 'schema_minor'").run("6");
  } finally {
    downgrade.close();
  }
  return outDir;
}

test("startUiServer on a schema_minor-6 project migrates it forward and serves /api/modules", async () => {
  const outDir = buildDowngradedProject();
  try {
    const h = await startUiServer({ projectDir: outDir, port: 0, host: "127.0.0.1", workers: false, prewarm: false, noAuth: true });
    try {
      const r = await fetch(`http://${h.host}:${h.port}/api/modules`);
      const bodyText = await r.text();
      assert.equal(r.status, 200, `expected /api/modules to succeed after migrate-on-open, got ${r.status}: ${bodyText}`);
      const body = JSON.parse(bodyText) as { rows: unknown[] };
      assert.ok(Array.isArray(body.rows), "/api/modules must answer with a rows array");
    } finally {
      await h.close();
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("the on-disk project.hbcproj is migrated to the current schema_minor after startUiServer starts", async () => {
  const outDir = buildDowngradedProject();
  try {
    const h = await startUiServer({ projectDir: outDir, port: 0, host: "127.0.0.1", workers: false, prewarm: false, noAuth: true });
    try {
      const check = new DatabaseSync(join(outDir, "project.hbcproj"), { readOnly: true });
      const row = check.prepare("SELECT value FROM meta WHERE key = 'schema_minor'").get() as { value: string };
      check.close();
      assert.notEqual(row.value, "6", "project.hbcproj must no longer be at schema_minor 6 once ui-server has started");
    } finally {
      await h.close();
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
