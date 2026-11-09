// Sweep tier, spec 28 section 7 on the REAL held-out app (react-navigation-example):
//   landing 1 fidelity  -- overlay names applied then reverted render byte-identically;
//   landing 3 file ops  -- make/rename/move/combine over the whole split tree, each judged
//                          by the shipped tree-equiv oracle against the real bundle, then
//                          reverted exactly.
// The numbers are printed (see docs/READABILITY.md "Held-out sweep") so a drift is visible.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireSweep } from "../../support/tiers.ts";
import { repoRoot } from "../../support/paths.ts";
import { decompileFunction, parseForDecompile, prepareModule } from "../../../src/decompile.ts";
import { analyseModule } from "../../../src/cfg/index.ts";
import { NameService, OverlayStore, regId, shortForm } from "../../../src/name-overlay/index.ts";
import { rawFrameBodies } from "../../../src/name-overlay/frames.ts";
import { listNameable } from "../../../src/artifact/frame-queries.ts";
import { FakeBackend } from "../../../src/workers/backend.ts";
import { runNamePass } from "../../../src/readability/name-pass.ts";
import type { NamePassTarget } from "../../../src/readability/name-pass.ts";
import { splitProject } from "../../../src/split/index.ts";
import { writeSplitResult } from "../../../src/split/write.ts";
import { defaultTreeEquivOracle, readModulesIndex, readTree, runFileOp, treeHash } from "../../../src/readability/file-ops.ts";
import { revertTransaction } from "../../../src/readability/transactions.ts";
import { freshProjectDb } from "../../support/readability-tree.ts";

const DIR = join(repoRoot(), "tests", "fixtures", "bundles", "react-navigation-example-0.85.3");
const HBC = join(DIR, "react-navigation-example.hbc");
const FN_CAP = 12;
const TARGET_CAP = 60;

test("sweep: spec 28 landing 1 fidelity on the held-out app -- names applied then reverted render byte-identically", async (t) => {
  if (!requireSweep(t)) return;
  if (!existsSync(HBC)) return t.skip("held-out bundle not present");
  const t0 = Date.now();
  const analysis = analyseModule(parseForDecompile(new Uint8Array(readFileSync(HBC)), {}).module, { strictEnv: false });
  const store = new OverlayStore({ bundle: "react-navigation-example" });
  const service = new NameService(analysis, store, { strictEnv: false });
  const frames = rawFrameBodies(analysis, { strictEnv: false });

  const bytes = new Uint8Array(readFileSync(HBC));
  const prepared = prepareModule(bytes, { strictEnv: false });
  const targets: NamePassTarget[] = [];
  const fns: number[] = [];
  for (let fn = 0; fn < analysis.module.functions.length && fns.length < FN_CAP; fn++) {
    const nameable = listNameable(frames, fn, store);
    if (nameable.length < 2) continue;
    let source: string;
    try {
      // fn-scoped source from the prepared module (as tools/readability/record.ts does):
      // NameService.render re-emits the whole module per call (~40 s on the real app).
      source = decompileFunction(bytes, fn, { strictEnv: false, prepared }).code;
    } catch {
      continue;
    }
    fns.push(fn);
    for (const reg of nameable) {
      if (targets.length >= TARGET_CAP) break;
      const id = regId(fn, reg.reg);
      targets.push({ bindingId: id, kind: "suggest-name", context: { target: shortForm(id), fn, reg: reg.reg, source } });
    }
  }
  assert.ok(targets.length > 0);
  // Scoped renders of the touched functions (render cost follows the functions touched,
  // docs/READABILITY.md "Render cost"); the whole-module render is no longer needed here.
  const renderTouched = (): string => fns.map((fn) => service.render({ fn }).code).join("\n");
  const before = renderTouched();
  const backend = new FakeBackend({
    replies: {
      "suggest-name": (req) =>
        JSON.stringify({
          names: [{ bindingId: { fn: req.context["fn"], reg: req.context["reg"] }, name: `sweepName${String(req.context["fn"])}_${String(req.context["reg"])}`, confidence: "high", evidence: "sweep fake" }],
          abstained: false,
        }),
    },
  });
  // One pass over every target; runNamePass renders the whole module before and after
  // itself (scoped to the touched functions) and reports its own backstop verdict.
  const result = await runNamePass(targets, { backend, service });
  const verdicts = new Set<string>([result.equiv.verdict]);
  const written = result.outcomes.filter((o) => o.written).length;
  const named = written > 0 ? renderTouched() : before;
  for (const o of result.outcomes) if (o.written) service.revert(o.target.bindingId);
  const after = renderTouched();
  const identical = after === before ? fns.length : 0;
  assert.ok(written === 0 || named !== before, "applied names must change the render");
  console.log(`SWEEP fidelity: ${String(fns.length)} fns, ${String(targets.length)} targets, ${String(written)} written, equiv ${[...verdicts].join("+")}, touched-function renders byte-identical after revert: ${String(after === before)}, ${String(fns.length)} fns, ${String(Date.now() - t0)} ms`);
  assert.ok(written > 0, `no fake name was written (equiv ${[...verdicts].join("+")})`);
  assert.equal(identical, fns.length);
});

test("sweep: spec 28 landing 3 file-op pass on the held-out app's split tree, reverted exactly", (t) => {
  if (!requireSweep(t)) return;
  if (!existsSync(HBC)) return t.skip("held-out bundle not present");
  const t0 = Date.now();
  const root = mkdtempSync(join(tmpdir(), "hbc2js-sweep-fileops-"));
  const treeDir = join(root, "tree");
  const projectDir = join(root, "project");
  const db = freshProjectDb();
  try {
    writeSplitResult(splitProject(new Uint8Array(readFileSync(HBC)), {}), treeDir);
    const index = readModulesIndex(readTree(treeDir));
    assert.ok(index.modules.length > 1000, "the real split tree has >1000 modules");
    const [a, b] = [index.modules[1]!, index.modules[2]!];
    const dirOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "");
    // The held-out bundle is HBC v98 and there is no v98 VM (HA-05: never fall back to Node), so the
    // SHIPPED tree-equiv oracle can only say INCONCLUSIVE here, and INCONCLUSIVE is never PASS: every op
    // must be refused with the real tree untouched. That is the honest result and is asserted below.
    // The structure leg + exact revert over the real 1782-module tree are measured with a stub PASS oracle.
    const stub = (): ReturnType<typeof defaultTreeEquivOracle> => ({ verdict: "PASS", why: "sweep stub", oracle: "stub", lines: 1 });
    const cA = index.modules[3]!;
    const requests = [
      { op: "make" as const, path: "swept_helper.js", content: "function helper() { return 1; }\n", origins: [{ module: a.id }], evidence: "sweep make" },
      { op: "rename" as const, from: a.file, to: `${dirOf(a.file)}SweptRename.js`, evidence: "sweep rename" },
      { op: "move" as const, from: b.file, to: `swept/${b.file.slice(dirOf(b.file).length)}`, evidence: "sweep move" },
      { op: "combine" as const, from: [cA.file, index.modules[4]!.file], to: "swept_combined.js", evidence: "sweep combine" },
    ];
    const start = treeHash(readTree(treeDir));
    let real = 0;
    for (const [i, req] of requests.entries()) {
      const attempt = runFileOp(req, { db, projectDir, treeDir, hbcPath: HBC, oracle: defaultTreeEquivOracle, ts: `2026-11-09T00:00:0${String(i)}Z` });
      if (!attempt.accepted && attempt.proof.verdict === "INCONCLUSIVE") real++;
      else if (attempt.accepted) assert.equal(attempt.proof.verdict, "PASS");
      assert.equal(treeHash(readTree(treeDir)), start, `a refused ${req.op} must leave the real tree untouched`);
    }
    const hashes = [start];
    const ids: string[] = [];
    const rows: string[] = [];
    for (const [i, req] of requests.entries()) {
      const attempt = runFileOp(req, { db, projectDir, treeDir, hbcPath: HBC, oracle: stub, ts: `2026-11-09T00:01:0${String(i)}Z` });
      rows.push(`${req.op}:${attempt.accepted ? "accepted" : "rejected"}`);
      assert.equal(attempt.accepted, true, `${req.op}: ${attempt.detail}`);
      ids.push(attempt.txId ?? "");
      hashes.push(treeHash(readTree(treeDir)));
    }
    for (let j = ids.length - 1; j >= 0; j--) {
      revertTransaction(db, projectDir, treeDir, ids[j]!, "alice", `2026-11-09T01:00:0${String(j)}Z`);
      assert.equal(treeHash(readTree(treeDir)), hashes[j], `revert of tx ${String(j)} restores the prior tree exactly`);
    }
    console.log(`SWEEP file-ops: shipped oracle refused ${String(real)}/${String(requests.length)} as INCONCLUSIVE (no v98 VM); stub-PASS structure leg [${rows.join(" ")}], ${String(ids.length)}/${String(ids.length)} reverted exactly, ${String(index.modules.length)} modules, ${String(Date.now() - t0)} ms`);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
