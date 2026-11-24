// Fans export's per-module readable rendering (`renderReadableOutcome`) out
// over worker threads. Rendering one module is independent of every other
// (the emit layout and pass caches are per-analysis and read-only), so a
// worker's own fresh analysis renders a module byte-for-byte as the main
// thread's would; results are keyed by module id and consumed in the
// original module order, so the tree is independent of the worker count
// (guarded by tests/gate/export/export-workers.test.ts). Work is handed out
// in small batches on demand, so one expensive module does not stall a
// whole pre-assigned slice.
import { serialize } from "node:v8";
import { cpus, totalmem } from "node:os";
import { Worker } from "node:worker_threads";
import { resolveWorkerCount } from "../parallel/pool.ts";
import type { ModuleAnalysis } from "../cfg/types.ts";
import { envGraphToTransfer } from "../cfg/env-graph.ts";
import { emitLayoutTransfer } from "../emit/index.ts";
import { siblingWorkerPath } from "../util/worker-path.ts";
import type { ReadableOutcome, ReadableRenderOptions } from "./tiers.ts";

export type RenderJob = Omit<ReadableRenderOptions, "analysis" | "store"> & {
  /** Relative cost estimate (the module's flat text length): jobs are handed
   *  out most expensive first, so one huge module starts at once instead of
   *  last and the pool does not idle behind it. Ordering never reaches the
   *  output -- results are keyed by module id. */
  readonly cost: number;
};

export interface RenderWorkerData {
  /** The bundle bytes, in a SharedArrayBuffer (one copy for every worker). */
  readonly bytes: SharedArrayBuffer;
  /** `v8.serialize({ envGraph, layout })` of the main analysis's env graph
   *  and emit layout, shared: both are whole-bundle (the env graph is minutes
   *  on a ~100k-function bundle; the layout reads the CFG of every
   *  env-owning function), so they are computed once on the main thread and
   *  every worker deserializes them instead. One `serialize` call keeps the
   *  objects the two share shared. */
  readonly envGraph: SharedArrayBuffer;
}

function toShared(bytes: Uint8Array): SharedArrayBuffer {
  const sab = new SharedArrayBuffer(bytes.byteLength);
  new Uint8Array(sab).set(bytes);
  return sab;
}

export type RenderWorkerReply =
  | { readonly ok: true; readonly results: readonly { readonly moduleId: number; readonly outcome: ReadableOutcome }[] }
  | { readonly ok: false; readonly error: { readonly message: string; readonly stack?: string } };

/** Below this many functions the pool's per-worker setup (a parse plus a
 *  decode of every function) costs about what it saves; render serially. */
export const POOL_MIN_FUNCTIONS = 8000;
/** Measured steady-state worker footprint per byte of bundle (deb,
 *  2026-11-24: ~105x on a 4.4 MB / 13.8k-function bundle, ~80x on a 16 MB /
 *  39k-function one); rounded up so the cap errs towards fewer workers. */
const WORKER_BYTES_PER_BUNDLE_BYTE = 110;
/** Share of physical memory the render workers may take together. */
const WORKER_MEMORY_SHARE = 0.5;
const DEFAULT_MAX_WORKERS = 12;

export interface RenderWorkerPlan {
  readonly count: number;
  /** Why the default was lowered, for the progress line; null when not. */
  readonly limitedBy: "small-bundle" | "memory" | null;
}

/** The render worker count for one export. An explicit count (`--workers`
 *  via `ExportOptions.workers`, or `HBC2JS_WORKERS`) is used as given;
 *  otherwise cpus - 2 (at most 12), lowered to 1 for a
 *  small bundle and capped so the workers' estimated footprint stays within
 *  half of physical memory. The tree never depends on the count. */
export function planRenderWorkers(explicit: number | undefined, functionCount: number, bundleBytes: number): RenderWorkerPlan {
  const env = process.env.HBC2JS_WORKERS;
  if (explicit !== undefined || (env !== undefined && env.trim().length > 0)) return { count: resolveWorkerCount(explicit), limitedBy: null };
  // Past ~12 workers the render phase stops shrinking (13.8k-function app on
  // a 32-core box: 16 workers 10 s, 30 workers 11 s) while memory keeps growing.
  const wanted = Math.max(1, Math.min(DEFAULT_MAX_WORKERS, cpus().length - 2));
  if (functionCount < POOL_MIN_FUNCTIONS) return { count: 1, limitedBy: "small-bundle" };
  const perWorker = Math.max(256 * 2 ** 20, bundleBytes * WORKER_BYTES_PER_BUNDLE_BYTE);
  const budget = totalmem() * WORKER_MEMORY_SHARE - process.memoryUsage().rss;
  const byMemory = Math.max(1, Math.floor(budget / perWorker));
  return byMemory < wanted ? { count: byMemory, limitedBy: "memory" } : { count: wanted, limitedBy: null };
}

const WORKER_SCRIPT = siblingWorkerPath("render-worker", import.meta.url);
const BATCH = 4;

/** Renders every job across `workerCount` workers. Rejects (after tearing
 *  every worker down) on any worker error -- never a partial result. */
export async function renderModulesInPool(
  bytes: Uint8Array,
  analysis: ModuleAnalysis,
  jobs: readonly RenderJob[],
  workerCount: number,
  onProgress?: (done: number) => void,
): Promise<Map<number, ReadableOutcome>> {
  const results = new Map<number, ReadableOutcome>();
  const count = Math.max(1, Math.min(workerCount, Math.ceil(jobs.length / BATCH)));
  const workers: Worker[] = [];
  let next = 0;
  let done = 0;
  const order = [...jobs].sort((a, b) => b.cost - a.cost || a.moduleId - b.moduleId);
  const data: RenderWorkerData = { bytes: toShared(bytes), envGraph: toShared(serialize({ envGraph: envGraphToTransfer(analysis.envGraph), layout: emitLayoutTransfer(analysis) })) };
  try {
    await new Promise<void>((resolve, reject) => {
      if (jobs.length === 0) {
        resolve();
        return;
      }
      let settled = false;
      let busy = 0;
      const fail = (err: unknown): void => {
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const feed = (w: Worker): void => {
        if (settled) return;
        if (next >= order.length) {
          if (busy === 0) {
            settled = true;
            resolve();
          }
          return;
        }
        // Expensive jobs go out one at a time, the long tail in batches.
        const batch = order.slice(next, next + (order[next]!.cost > 50_000 ? 1 : BATCH));
        next += batch.length;
        busy++;
        w.postMessage(batch);
      };
      for (let i = 0; i < count; i++) {
        const w = new Worker(WORKER_SCRIPT, { workerData: data });
        workers.push(w);
        w.on("message", (msg: RenderWorkerReply) => {
          busy--;
          if (!msg.ok) {
            fail(new Error(`hbc2js export: render worker failed: ${msg.error.message}${msg.error.stack ? `\n${msg.error.stack}` : ""}`));
            return;
          }
          for (const r of msg.results) results.set(r.moduleId, r.outcome);
          done += msg.results.length;
          onProgress?.(done);
          feed(w);
        });
        w.once("error", (err) => fail(err));
        w.once("exit", (code) => {
          if (!settled) fail(new Error(`hbc2js export: render worker exited early with code ${code}`));
        });
      }
      for (const w of workers) feed(w);
    });
  } finally {
    await Promise.all(workers.map((w) => w.terminate().catch(() => undefined)));
  }
  return results;
}
