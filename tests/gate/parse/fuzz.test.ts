// docs/specs/01-parser.md §8 T8 — deterministic fuzz. 2000 mutants per gate binary,
// zero non-Hbc2jsError escapes, zero timeouts, always returns within budget.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHbc } from "../../../src/index.ts";
import { Hbc2jsError } from "../../../src/errors.ts";
import { listFixtures } from "../../support/fixtures.ts";
import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";
import { makeRng, mutate } from "../../support/fuzz-mutants.ts";
import type { FuzzJob } from "../../support/fuzz-worker.ts";

// xorshift32, seeded — deterministic and printed on failure.
const MUTANTS_PER_BINARY = Number(process.env["HBC2JS_FUZZ_MUTANTS_PER_BINARY"] ?? 2000);

test(`${MUTANTS_PER_BINARY} deterministic mutants per gate binary (spec 01 §8 T8 default) never throw anything but Hbc2jsError, and always terminate quickly`, async () => {
  const seed = 0x2b3c4d5e;
  const rng = makeRng(seed);
  // One xorshift stream across all binaries, in fixture order. Advance it
  // here (mutate only) to record every binary's start state, then fuzz the
  // binaries on worker threads: same mutants as the old single-thread loop.
  const jobs: FuzzJob[] = [];
  for (const f of listFixtures()) {
    for (const b of f.binaries) {
      const base = b.bytes();
      jobs.push({ label: `${f.group}/${f.name} v${b.version}`, bytes: base, rngState: rng.state(), count: MUTANTS_PER_BINARY });
      for (let i = 0; i < MUTANTS_PER_BINARY; i++) mutate(base, rng);
    }
  }
  const nWorkers = Math.max(1, Math.min(8, availableParallelism()));
  const batches: FuzzJob[][] = Array.from({ length: nWorkers }, () => []);
  jobs.forEach((j, i) => batches[i % nWorkers]!.push(j));
  const results = await Promise.all(
    batches.filter((b) => b.length > 0).map(
      (batch) =>
        new Promise<{ checked: number; failures: string[] }>((resolve, reject) => {
          const w = new Worker(new URL("../../support/fuzz-worker.ts", import.meta.url), { workerData: { jobs: batch, seed } });
          w.once("message", resolve);
          w.once("error", reject);
        }),
    ),
  );
  const failures = results.flatMap((r) => r.failures);
  assert.deepEqual(failures, [], failures.slice(0, 5).join("\n"));
  const mutantsChecked = results.reduce((n, r) => n + r.checked, 0);
  assert.ok(mutantsChecked > 1000, `expected >1000 mutants checked, got ${mutantsChecked}`);
});

test("strings.get() never throws anything but Hbc2jsError on a mutated file that still parses", () => {
  const rng = makeRng(0xdeadbeef);
  const fixtures = listFixtures({ group: "hermes-dec-sample" });
  const base = fixtures[0]!.binaries[0]!.bytes();
  for (let i = 0; i < 100; i++) {
    const mutant = mutate(base, rng);
    let m;
    try {
      m = parseHbc(mutant);
    } catch (e) {
      assert.ok(e instanceof Hbc2jsError);
      continue;
    }
    for (let id = 0; id < m.strings.count; id++) {
      try {
        m.strings.get(id);
      } catch (e) {
        assert.ok(e instanceof Hbc2jsError, `strings.get(${id}) threw non-Hbc2jsError`);
      }
    }
  }
});
