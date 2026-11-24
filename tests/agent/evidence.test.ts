// docs/specs/35-agent-harness.md Part 1: the evidence helper, and acceptance 4
// (MCP results). CLI acceptance 1-3 live in tests/cli/machine-evidence.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withEvidence, validateEvidence, EVIDENCE_LABELS } from "../../src/agent/evidence.ts";
import { buildToolTable } from "../../src/mcp/server.ts";
import { registerReadabilityTools } from "../../src/mcp/tools.ts";
import { FakeBackend } from "../../src/workers/backend.ts";
import { HeuristicBackend } from "../../src/workers/backends/heuristic.ts";
import { makeTree } from "../support/readability-tree.ts";

const prov = { producer: "hbc2js" as const, version: "0.0.0" };

test("evidence helper: the three labels are fixed, and withEvidence returns a copy with an evidence block", () => {
  assert.deepEqual([...EVIDENCE_LABELS], ["observed", "derived", "inferred"]);
  const reply = { a: 1, b: "x" };
  const out = withEvidence(reply, { labels: { a: "observed", b: "inferred" }, provenance: prov });
  assert.deepEqual(Object.keys(reply), ["a", "b"], "input not mutated");
  assert.deepEqual(out.evidence.labels, { a: "observed", b: "inferred" });
  assert.deepEqual(out.evidence.unknowns, []);
  assert.deepEqual(out.evidence.limitations, []);
  assert.equal(out.a, 1);
});

test("evidence helper: an illegal label or a label for a missing field is refused; JSON pointers resolve", () => {
  assert.throws(() => withEvidence({ a: 1 }, { labels: { a: "guess" as never }, provenance: prov }), /label/);
  assert.throws(() => withEvidence({ a: 1 }, { labels: { b: "observed" }, provenance: prov }), /not present/);
  assert.doesNotThrow(() => withEvidence({ a: { b: [1] } }, { labels: { "/a/b/0": "derived" }, provenance: prov }));
  assert.throws(() => withEvidence({ a: null }, { labels: {}, unknowns: [{ field: "zzz", reason: "r" }], provenance: prov }), /not present/);
  assert.deepEqual(validateEvidence({ a: 1 }), ["reply has no evidence block"]);
});

test("evidence 4: MCP read tools carry evidence and every other field is unchanged", () => {
  const calls: unknown[] = [];
  const fakeCtx = {
    resources: {
      source: (fn: number) => ({ text: `src${fn}`, totalLines: 1, truncated: false }),
      disasm: (fn: number) => ({ text: `dis${fn}`, totalLines: 1, truncated: false }),
      searchFunctions: () => ({ rows: [], total: 0 }),
    },
    tools: {},
  } as never;
  const table = buildToolTable(fakeCtx);
  const src = table["get_source"]!.handler({ fn: 3 }) as Record<string, any>;
  assert.equal(src.evidence.labels.text, "derived");
  assert.equal(src.evidence.provenance.producer, "hbc2js");
  const { evidence: _e, ...rest } = src;
  assert.deepEqual(rest, { text: "src3", totalLines: 1, truncated: false });
  const dis = table["get_disasm"]!.handler({ fn: 3 }) as Record<string, any>;
  assert.equal(dis.evidence.labels.text, "observed");
  void calls;
  // `help` and write tools are left alone.
  assert.equal((table["help"]!.handler({}) as any).evidence, undefined);
});

test("evidence 4: readability tools label model output inferred and name the backend; heuristic says heuristic", () => {
  for (const [backend, id] of [[new FakeBackend({}), "fake"], [new HeuristicBackend(), "heuristic"]] as const) {
    const { db, treeDir, projectDir } = makeTree();
    const ctx = { db, projectDir, treeDir, backend } as never;
    const table = buildToolTable({ resources: {}, tools: {} } as never, ctx);
    const res = table["list_suggestions"]!.handler({}) as Record<string, any>;
    assert.equal(res.evidence.provenance.backend, id);
    const keys = Object.keys(res).filter((k) => k !== "evidence");
    assert.ok(keys.length > 0);
    for (const k of keys) assert.ok(["inferred", "derived"].includes(res.evidence.labels[k]), k);
    // The raw registered handlers (no evidence) stay exactly as before.
    const raw = registerReadabilityTools(ctx).list_suggestions({}) as Record<string, unknown>;
    assert.equal(raw["evidence"], undefined);
    const { evidence: _e, ...rest } = res;
    assert.deepEqual(rest, raw);
  }
});
