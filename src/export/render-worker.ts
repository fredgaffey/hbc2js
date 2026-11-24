// The export render worker (spec 29 §4 per-module readable rendering, fanned
// out over `src/export/render-pool.ts`). Each worker independently parses and
// analyses the same bytes, exactly as `splitProject` does for the main
// thread's analysis (`analyseModule(parseHbc(bytes), { strictEnv: false })`)
// but with the main thread's env graph preset (render-pool.ts), then renders whatever batches of modules the main thread hands it. It sends
// back only `ReadableOutcome`s (plain strings); the flat fallback and every
// cross-module step stay on the main thread, in module order.
import { deserialize } from "node:v8";
import { parentPort, workerData } from "node:worker_threads";
import { analyseModule } from "../cfg/index.ts";
import { envGraphFromTransfer } from "../cfg/env-graph.ts";
import type { EnvGraphTransfer } from "../cfg/env-graph.ts";
import { parseHbc } from "../parse/module.ts";
import { renderReadableOutcome } from "./tiers.ts";
import type { RenderJob, RenderWorkerData, RenderWorkerReply } from "./render-pool.ts";

const data = workerData as RenderWorkerData;
let analysis: ReturnType<typeof analyseModule> | undefined;

function post(reply: RenderWorkerReply): void {
  parentPort!.postMessage(reply);
}

parentPort!.on("message", (jobs: readonly RenderJob[]) => {
  try {
    analysis ??= analyseModule(
      parseHbc(new Uint8Array(data.bytes)),
      { strictEnv: false },
      { envGraph: envGraphFromTransfer(deserialize(new Uint8Array(data.envGraph)) as EnvGraphTransfer), releaseDecoded: true },
    );
    const results = jobs.map((job) => ({
      moduleId: job.moduleId,
      outcome: renderReadableOutcome({ ...job, analysis: analysis! }),
    }));
    post({ ok: true, results });
  } catch (e) {
    const err = e as { message?: string; stack?: string };
    post({ ok: false, error: { message: err.message ?? String(e), ...(err.stack !== undefined ? { stack: err.stack } : {}) } });
  }
});
