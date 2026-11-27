// The export render worker (spec 29 §4 per-module readable rendering, fanned
// out over `src/export/render-pool.ts`). Each worker independently parses and
// analyses the same bytes, exactly as `splitProject` does for the main
// thread's analysis (`analyseModule(parseHbc(bytes), { strictEnv: false })`)
// but with the main thread's env graph preset (render-pool.ts), then renders whatever batches of modules the main thread hands it. It sends
// back only `ReadableOutcome`s (plain strings); the flat fallback and every
// cross-module step stay on the main thread, in module order.
import { deserialize, getHeapStatistics, serialize } from "node:v8";
import { parentPort, workerData } from "node:worker_threads";
import { analyseModule } from "../cfg/index.ts";
import { envGraphFromTransfer } from "../cfg/env-graph.ts";
import type { EnvGraphTransfer } from "../cfg/env-graph.ts";
import { presetEmitLayout } from "../emit/index.ts";
import type { EmitLayoutTransfer } from "../emit/index.ts";
import { parseHbc } from "../parse/module.ts";
import { renderReadableOutcome, renderReadableSubtree } from "./tiers.ts";
import type { SubtreeResult } from "../emit/index.ts";
import type { RenderTask, RenderWorkerData, RenderWorkerReply } from "./render-pool.ts";

const data = workerData as RenderWorkerData;
let analysis: ReturnType<typeof analyseModule> | undefined;
const RELEASE_AT = 384 * 2 ** 20;
/** `HBC2JS_RENDER_TRACE=1`: one stderr line per batch (module ids, cost,
 *  render ms, heap), for finding a bundle's expensive modules. */
const TRACE = process.env.HBC2JS_RENDER_TRACE === "1";

function post(reply: RenderWorkerReply, transfer: ArrayBuffer[] = []): void {
  parentPort!.postMessage(reply, transfer);
}

parentPort!.on("message", (jobs: readonly RenderTask[]) => {
  try {
    if (analysis === undefined) {
      const shared = deserialize(new Uint8Array(data.envGraph)) as { envGraph: EnvGraphTransfer; layout: EmitLayoutTransfer };
      analysis = analyseModule(parseHbc(new Uint8Array(data.bytes)), { strictEnv: false }, { envGraph: envGraphFromTransfer(shared.envGraph), releaseDecoded: true });
      presetEmitLayout(analysis, shared.layout);
    }
    const t0 = TRACE ? performance.now() : 0;
    const results: { moduleId: number; outcome: ReturnType<typeof renderReadableOutcome> }[] = [];
    const subtrees: { moduleId: number; data: Uint8Array | null }[] = [];
    const transfer: ArrayBuffer[] = [];
    for (const task of jobs) {
      const opts = { ...task.job, analysis: analysis! };
      if (task.kind === "module") results.push({ moduleId: task.job.moduleId, outcome: renderReadableOutcome(opts) });
      else if (task.kind === "assemble") {
        const map = new Map<string, SubtreeResult>();
        for (const b of task.results) {
          const r = deserialize(b) as SubtreeResult;
          map.set(r.key, r);
        }
        const stats = { hits: 0, misses: 0 };
        results.push({ moduleId: task.job.moduleId, outcome: renderReadableOutcome(opts, { results: map, stats }) });
        if (TRACE) process.stderr.write(`hbc2js render-trace: assembled module ${task.job.moduleId} from ${map.size} parts (${stats.hits} spliced, ${stats.misses} emitted in place)\n`);
      } else {
        const r = renderReadableSubtree(opts, task.sub);
        const data = r === null ? null : new Uint8Array(serialize(r));
        if (data !== null) transfer.push(data.buffer as ArrayBuffer);
        subtrees.push({ moduleId: task.job.moduleId, data });
      }
    }
    // Past RELEASE_AT of live-ish heap, drop the per-function caches, so
    // memory tracks the module in hand rather than every function this
    // worker has rendered (rebuilt on demand, identically); below it they
    // stay warm for the functions modules share.
    if (TRACE) process.stderr.write(`hbc2js render-trace: ${jobs.map((j) => `${j.kind === "module" ? "module" : j.kind === "assemble" ? "assemble" : `fn#${j.sub.index} of`} ${j.job.moduleId}(${j.job.cost})`).join(" ")} ${Math.round(performance.now() - t0)} ms, heap ${Math.round(getHeapStatistics().used_heap_size / 2 ** 20)} MB, external ${Math.round(getHeapStatistics().external_memory / 2 ** 20)} MB\n`);
    let h = getHeapStatistics();
    if (h.used_heap_size > RELEASE_AT) {
      analysis.releaseCaches?.();
      h = getHeapStatistics();
    }
    post({ ok: true, results, subtrees, heap: { used: h.used_heap_size + h.external_memory, total: h.total_heap_size + h.external_memory } }, transfer);
  } catch (e) {
    const err = e as { message?: string; stack?: string };
    post({ ok: false, error: { message: err.message ?? String(e), ...(err.stack !== undefined ? { stack: err.stack } : {}) } });
  }
});
