// Worker thread for tests/gate/parse/fuzz.test.ts: fuzzes a batch of binaries
// from recorded RNG start states and reports the first failure per binary.
import { parentPort, workerData } from "node:worker_threads";
import { parseHbc } from "../../src/index.ts";
import { Hbc2jsError } from "../../src/errors.ts";
import { timeScale } from "./tiers.ts";
import { makeRng, mutate } from "./fuzz-mutants.ts";

export interface FuzzJob { label: string; bytes: Uint8Array; rngState: number; count: number }
const { jobs, seed } = workerData as { jobs: FuzzJob[]; seed: number };
const budgetMs = Math.max(200 * timeScale(), 500);
const failures: string[] = [];
let checked = 0;
for (const job of jobs) {
  const rng = makeRng(job.rngState);
  for (let i = 0; i < job.count; i++) {
    const mutant = mutate(job.bytes, rng);
    const start = performance.now();
    try {
      const m = parseHbc(mutant);
      for (const fn of m.functions) {
        const body = fn.body();
        if (!(body.byteOffset + body.length <= mutant.length)) failures.push(`${job.label} seed ${seed}: function body view escapes the file`);
      }
    } catch (e) {
      if (!(e instanceof Hbc2jsError)) failures.push(`${job.label} mutant ${i} (seed ${seed}) threw non-Hbc2jsError: ${e instanceof Error ? e.stack : String(e)}`);
    }
    const elapsed = performance.now() - start;
    if (!(elapsed < budgetMs)) failures.push(`${job.label} mutant ${i} took ${elapsed}ms (budget ${budgetMs}ms)`);
    checked++;
  }
}
parentPort!.postMessage({ checked, failures });
