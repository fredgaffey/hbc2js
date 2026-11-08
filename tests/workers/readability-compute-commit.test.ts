// tests/workers/readability-compute-commit.test.ts -- regression for the
// docs/BUGS.md 2026-09-13 row "readability-rewrite-function/combine-files
// still run in-process" (PUSHBACK P-65). The compute half of both surfaces
// must return a plain-data transaction without touching the DB or the tree,
// so a worker thread can run it and the main thread (the single writer on the
// hash-chained log) commits it; and the worker must accept both job kinds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { makeTree } from "../support/readability-tree.ts";
import { repoRoot } from "../support/paths.ts";
import { FakeBackend } from "../../src/workers/backend.ts";
import { listTransactions } from "../../src/readability/transactions.ts";
import { readTree, type TreeEquivOracle } from "../../src/readability/file-ops.ts";
import { computeFileOp, commitFileOp, fileOp, type ReadabilityContext } from "../../src/readability/surfaces.ts";
import type { ReadabilityWorkerInput, ReadabilityWorkerMessage } from "../../src/workers/readability-worker.ts";

const PASS_TREE: TreeEquivOracle = () => ({ verdict: "PASS", why: "trace-equivalent", oracle: "stub", lines: 4 });
const HBC = join(repoRoot(), "tests", "fixtures", "constructs", "04-for-loop-basic", "v96.hbc");
const WORKER_SCRIPT = fileURLToPath(new URL("../../src/workers/readability-worker.ts", import.meta.url));
const REQ = { op: "combine", from: ["src/module_1.js", "src/module_2.js"], to: "src/Login.js", evidence: "one unit" } as const;

test("computeFileOp returns a structured-clone-safe transaction and touches neither the DB nor the tree; commitFileOp then equals fileOp", () => {
  const a = makeTree();
  const ctxA: ReadabilityContext = { db: a.db, projectDir: a.projectDir, treeDir: a.treeDir, backend: new FakeBackend({}), oracle: PASS_TREE };
  const before = [...readTree(a.treeDir)];
  const plan = computeFileOp(ctxA, REQ);
  assert.equal(plan.result.accepted, true);
  assert.deepEqual(structuredClone(plan), plan, "the plan must be plain data (it crosses the thread boundary)");
  assert.equal(listTransactions(a.db).length, 0, "compute must not write the DB");
  assert.deepEqual([...readTree(a.treeDir)], before, "compute must not write the tree");
  const committed = commitFileOp(ctxA, plan);

  const b = makeTree();
  const ctxB: ReadabilityContext = { db: b.db, projectDir: b.projectDir, treeDir: b.treeDir, backend: new FakeBackend({}), oracle: PASS_TREE };
  const direct = fileOp(ctxB, REQ);
  assert.equal(committed.accepted, direct.accepted);
  assert.equal(committed.txId, direct.txId);
  assert.equal(listTransactions(a.db).length, 1);
  assert.deepEqual([...readTree(a.treeDir)], [...readTree(b.treeDir)]);
});

function runWorker(input: ReadabilityWorkerInput): Promise<ReadabilityWorkerMessage> {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER_SCRIPT, { workerData: input });
    w.once("message", (m: ReadabilityWorkerMessage) => { void w.terminate(); resolve(m); });
    w.once("error", reject);
  });
}

test("the readability worker accepts the rewrite-function and combine-files job kinds and returns plain-data plans", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-compute-commit-"));
  try {
    const base = { hbcPath: HBC, projectDir: dir, treeDir: dir, backendId: "heuristic", surface: "ui" } as const;
    const rw = await runWorker({ ...base, job: "rewrite-function", args: { fn: 0 } } as unknown as ReadabilityWorkerInput);
    assert.equal(rw.ok, true, rw.ok ? "" : rw.error);
    const plan = (rw as { result: { result: { accepted: boolean } } }).result;
    assert.equal(plan.result.accepted, false, "the heuristic backend proposes no rewrite");
    // A combine over a tree with no such files is a refusal reported by the
    // worker (not a crash, not "unknown job"), and is not transient.
    const cb = await runWorker({ ...base, job: "combine-files", fileOp: REQ, tracedOrigins: [] } as unknown as ReadabilityWorkerInput);
    assert.equal(cb.ok, false);
    assert.doesNotMatch((cb as { error: string }).error, /unknown job|is not a function/i);
    assert.equal((cb as { transient: boolean }).transient, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  void readFileSync;
});
