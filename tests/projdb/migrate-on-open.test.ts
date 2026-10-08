// tests/projdb/migrate-on-open.test.ts — docs/BUGS.md 2026-09-18
// `ix_module_dep_kind` row: a read-only connection can never run
// `migrateProjectDb` (`src/projdb/db.ts`), so a purely read-only caller
// against a project no read-write command has touched since a schema bump
// used to hit the first stale query and throw a raw SQLite `no such table:
// ix_module_dep_kind` error. `openProjectDbReadonly`
// (`src/projdb/artifact-read.ts`) now checks `meta.schema_minor` itself and
// throws a named `ProjectDbVersionError` naming the fix instead. Companion
// to `tests/ui-server/migrate-on-open.test.ts`, which covers the
// read-write-migrates-first ordering fix in `startUiServer`/`runMcpServer`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openProjectDb, ProjectDbVersionError, SCHEMA_MINOR } from "../../src/projdb/db.ts";
import { openProjectDbReadonly } from "../../src/projdb/artifact-read.ts";

function buildDowngradedProject(): string {
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-projdb-migrate-on-open-"));
  const dbPathStr = join(outDir, "project.hbcproj");
  const db = openProjectDb(dbPathStr);
  db.close();
  const downgrade = new DatabaseSync(dbPathStr);
  try {
    downgrade.exec("DROP TABLE ix_module_dep_kind;");
    downgrade.prepare("UPDATE meta SET value = ? WHERE key = 'schema_minor'").run("6");
  } finally {
    downgrade.close();
  }
  return outDir;
}

test("openProjectDbReadonly on a schema_minor-6 project throws a named ProjectDbVersionError, not a raw SQLite error", () => {
  const outDir = buildDowngradedProject();
  try {
    assert.throws(
      () => openProjectDbReadonly(outDir),
      (err: unknown) => {
        assert.ok(err instanceof ProjectDbVersionError, `expected ProjectDbVersionError, got ${err instanceof Error ? err.constructor.name : typeof err}`);
        assert.match((err as Error).message, /schema_minor 6/);
        assert.match((err as Error).message, new RegExp(String(SCHEMA_MINOR)));
        assert.doesNotMatch((err as Error).message, /no such table/i, "must not leak the raw SQLite error");
        return true;
      },
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("openProjectDbReadonly on a fresh, current-schema project opens fine", () => {
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-projdb-migrate-on-open-fresh-"));
  try {
    const db = openProjectDb(join(outDir, "project.hbcproj"));
    db.close();
    const readonly = openProjectDbReadonly(outDir);
    assert.doesNotThrow(() => readonly.prepare("SELECT id FROM ix_module_dep_kind LIMIT 1").all());
    readonly.close();
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
