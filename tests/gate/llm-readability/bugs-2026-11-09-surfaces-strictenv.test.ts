// bugs-2026-11-09-surfaces-strictenv: a real app (react-navigation-example)
// has 182 environment accesses analysis cannot resolve statically; the
// readability surfaces built NameService / rawFrameBodies strict, so every
// surface threw E_ENV_UNRESOLVED for the whole module. No committed construct
// has an unresolvable access (see tests/gate/emit/lenient-env.test.ts), so one
// site is removed from a real fixture's env graph and handed to the surface
// through `ctx.analysis`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { parseM4 } from "../../support/m4.ts";
import { makeTree } from "../../support/readability-tree.ts";
import { analyseModule } from "../../../src/cfg/index.ts";
import type { ModuleAnalysis } from "../../../src/cfg/types.ts";
import { FakeBackend } from "../../../src/workers/backend.ts";
import { NameService, OverlayStore } from "../../../src/name-overlay/index.ts";
import { ErrorCode, Hbc2jsError } from "../../../src/errors.ts";
import { classifyModule, suggestNames } from "../../../src/readability/surfaces.ts";
import type { ReadabilityContext } from "../../../src/readability/surfaces.ts";

const FIXTURE = "22-nested-closures-counters";
const path = join(repoRoot(), "tests", "fixtures", "constructs", FIXTURE, "v94.hbc");

function unresolvedAnalysis(): ModuleAnalysis {
  const { module } = parseM4(new Uint8Array(readFileSync(path)));
  const a = analyseModule(module, { strictEnv: true });
  const resolvedAt = new Map(a.envGraph.resolvedAt);
  resolvedAt.delete([...resolvedAt.keys()][0]!);
  return { ...a, envGraph: { ...a.envGraph, resolvedAt }, cfg: (i) => a.cfg(i), decoded: (i) => a.decoded(i) };
}

function ctx(analysis: ModuleAnalysis): ReadabilityContext {
  const { db, treeDir, projectDir } = makeTree();
  const backend = new FakeBackend({ replies: { "suggest-name": () => JSON.stringify({ names: [], abstained: true }) } });
  return { db, projectDir, treeDir, backend, hbcPath: path, analysis };
}

test("bugs-2026-11-09-surfaces-strictenv: control -- a strict NameService still refuses the unresolved site", () => {
  const svc = new NameService(unresolvedAnalysis(), new OverlayStore());
  assert.throws(() => { for (let i = 0; i < 50; i++) svc.render({ fn: i }); }, (e: unknown) => e instanceof Hbc2jsError && e.code === ErrorCode.E_ENV_UNRESOLVED);
});

test("bugs-2026-11-09-surfaces-strictenv: suggest_names and classify_module degrade instead of throwing", async () => {
  const c = ctx(unresolvedAnalysis());
  const r = await suggestNames(c, { target: { module: 0 } });
  assert.ok(Array.isArray(r.suggestions));
  const cm = await classifyModule(c, { target: { module: 0 } } as never).catch((e: unknown) => e);
  assert.ok(!(cm instanceof Hbc2jsError && cm.code === ErrorCode.E_ENV_UNRESOLVED), "classify_module must not throw E_ENV_UNRESOLVED");
});
