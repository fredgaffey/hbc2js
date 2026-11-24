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

/** One worker's heap after a batch (its own isolate, `v8.getHeapStatistics`,
 *  external memory included): `used` is live-ish, `total` what V8 holds. */
export interface WorkerHeap {
  readonly used: number;
  readonly total: number;
}

export type RenderWorkerReply =
  | { readonly ok: true; readonly results: readonly { readonly moduleId: number; readonly outcome: ReadableOutcome }[]; readonly heap: WorkerHeap }
  | { readonly ok: false; readonly error: { readonly message: string; readonly stack?: string } };

/** Below this many functions the pool's per-worker setup (a parse plus a
 *  decode of every function) costs about what it saves; render serially. */
export const POOL_MIN_FUNCTIONS = 8000;
/** First guess at one worker's footprint per byte of bundle, before any
 *  worker has reported (deb, 2026-11-24, workers dropping their per-module
 *  caches: see spec 29 section 12). Only the starting count uses it; the pool
 *  then sizes itself from what the workers measure (`WorkerHeap`). */
const WORKER_BYTES_PER_BUNDLE_BYTE = 60;
const WORKER_MIN_BYTES = 256 * 2 ** 20;
/** Native (non-heap) memory per worker on top of its V8 heap: thread stack,
 *  code space, the deserialized env-graph buffers' malloc slack. */
const WORKER_NATIVE_BYTES = 96 * 2 ** 20;
/** Share of physical memory the whole export (main thread included) may
 *  take at defaults. */
const MEMORY_SHARE = 0.5;
const DEFAULT_MAX_WORKERS = 12;
/** The per-worker old-generation bound the pool sets: the worker's share of
 *  the budget, within these. More than ~1 GB buys no speed (deb, 15.5k-
 *  function app, 12 workers: 512 MB 32 s, 768 MB 29 s, 1.1 GB 31 s; noisy)
 *  and only lets garbage pile up. */
const WORKER_MIN_HEAP_MB = 512;
const WORKER_MAX_HEAP_MB = 1024;

export interface RenderWorkerPlan {
  /** Workers to start with. */
  readonly count: number;
  /** Why the default was lowered, for the progress line; null when not. */
  readonly limitedBy: "small-bundle" | "memory" | null;
  /** Bytes the workers may take together, or null for an explicit count
   *  (used as given, never resized). */
  readonly budget: number | null;
  /** Never more workers than this, however much memory there is. */
  readonly max: number;
}

/** One worker's expected footprint before any has reported. */
export function initialWorkerEstimate(bundleBytes: number): number {
  return Math.max(WORKER_MIN_BYTES, bundleBytes * WORKER_BYTES_PER_BUNDLE_BYTE) + WORKER_NATIVE_BYTES;
}

/** The render worker plan for one export. An explicit count (`--workers`
 *  via `ExportOptions.workers`, or `HBC2JS_WORKERS`) is used as given;
 *  otherwise cpus - 2 (at most 12), 1 for a small bundle, and the pool
 *  keeps the workers within a memory budget: half of physical memory less
 *  what the main thread already holds. The starting count comes from a
 *  per-byte estimate; `renderModulesInPool` then resizes against the heap
 *  the workers report. The tree never depends on the count. */
export function planRenderWorkers(
  explicit: number | undefined,
  functionCount: number,
  bundleBytes: number,
  mem: { readonly total: number; readonly mainRss: number; readonly cpus: number } = { total: totalmem(), mainRss: process.memoryUsage().rss, cpus: cpus().length },
): RenderWorkerPlan {
  const env = process.env.HBC2JS_WORKERS;
  if (explicit !== undefined || (env !== undefined && env.trim().length > 0)) {
    const n = resolveWorkerCount(explicit);
    return { count: n, limitedBy: null, budget: null, max: n };
  }
  // Past ~12 workers the render phase stops shrinking (13.8k-function app on
  // a 32-core box: 16 workers 10 s, 30 workers 11 s) while memory keeps growing.
  const wanted = Math.max(1, Math.min(DEFAULT_MAX_WORKERS, mem.cpus - 2));
  if (functionCount < POOL_MIN_FUNCTIONS) return { count: 1, limitedBy: "small-bundle", budget: null, max: 1 };
  const budget = Math.max(0, mem.total * MEMORY_SHARE - mem.mainRss);
  const byMemory = Math.max(1, Math.floor(budget / initialWorkerEstimate(bundleBytes)));
  return byMemory < wanted ? { count: byMemory, limitedBy: "memory", budget, max: wanted } : { count: wanted, limitedBy: null, budget, max: wanted };
}

export interface PoolStats {
  /** Most workers alive at once. */
  peakWorkers: number;
  /** Largest heap any worker reported (`WorkerHeap.total`), bytes. */
  peakWorkerHeap: number;
}

const WORKER_SCRIPT = siblingWorkerPath("render-worker", import.meta.url);
const BATCH = 4;

/** Renders every job across the plan's workers. Rejects (after tearing
 *  every worker down) on any worker error -- never a partial result. With a
 *  memory budget (`plan.budget`), the pool's footprint is re-measured on
 *  every reply (each live worker's last reported heap plus native
 *  overhead): a worker is retired between batches while the pool is over
 *  budget, and one more is started while another of the largest seen still
 *  fits (up to `plan.max`) and enough work is left to repay its setup. */
export async function renderModulesInPool(
  bytes: Uint8Array,
  analysis: ModuleAnalysis,
  jobs: readonly RenderJob[],
  plan: Pick<RenderWorkerPlan, "count" | "budget" | "max">,
  onProgress?: (done: number) => void,
  stats: PoolStats = { peakWorkers: 0, peakWorkerHeap: 0 },
): Promise<Map<number, ReadableOutcome>> {
  const results = new Map<number, ReadableOutcome>();
  const count = Math.max(1, Math.min(plan.count, Math.ceil(jobs.length / BATCH)));
  // With a memory budget, each worker's old generation is bounded to its
  // share (within WORKER_MIN_HEAP_MB..WORKER_MAX_HEAP_MB; `HBC2JS_WORKER_HEAP_MB` overrides): a worker's live heap is small (deb,
  // 15.5k-function app: under 500 MB after a GC) but V8 lets garbage pile
  // up to the limit it is given, and that, not live data, was the pool's
  // RSS. A module that needs more is redone without the bound (below).
  const envLimit = Number.parseInt(process.env.HBC2JS_WORKER_HEAP_MB ?? "", 10);
  const heapLimitMb = Number.isFinite(envLimit) && envLimit > 0 ? envLimit : plan.budget !== null ? Math.min(WORKER_MAX_HEAP_MB, Math.max(WORKER_MIN_HEAP_MB, Math.floor((plan.budget / count - WORKER_NATIVE_BYTES) / 2 ** 20))) : null;
  const workers: Worker[] = [];
  let live = 0;
  let next = 0;
  let done = 0;
  const order = [...jobs].sort((a, b) => b.cost - a.cost || a.moduleId - b.moduleId);
  const data: RenderWorkerData = { bytes: toShared(bytes), envGraph: toShared(serialize({ envGraph: envGraphToTransfer(analysis.envGraph), layout: emitLayoutTransfer(analysis) })) };
  // The workers have everything whole-bundle they need; the caller's own
  // per-function caches (every function, from the split) are dead weight
  // from here on (rebuilt on demand if the caller renders again).
  analysis.releaseCaches?.();
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
      const finishIfDone = (): void => {
        if (!settled && next >= order.length && busy === 0) {
          settled = true;
          resolve();
        }
      };
      const feed = (w: Worker): void => {
        if (settled) return;
        if (next >= order.length) {
          finishIfDone();
          return;
        }
        // Expensive jobs go out one at a time, the long tail in batches.
        const batch = order.slice(next, next + (order[next]!.cost > 50_000 ? 1 : BATCH));
        next += batch.length;
        busy++;
        inflight.set(w, batch);
        w.postMessage(batch);
      };
      const retired = new Set<Worker>();
      const unlimited = new Set<Worker>();
      const heapOf = new Map<Worker, number>();
      const inflight = new Map<Worker, readonly RenderJob[]>();
      const spawn = (limited = heapLimitMb !== null): Worker => {
        const w = new Worker(WORKER_SCRIPT, { workerData: data, ...(limited && heapLimitMb !== null ? { resourceLimits: { maxOldGenerationSizeMb: heapLimitMb } } : {}) });
        if (!limited) unlimited.add(w);
        workers.push(w);
        live++;
        stats.peakWorkers = Math.max(stats.peakWorkers, live);
        w.on("message", (msg: RenderWorkerReply) => {
          busy--;
          inflight.delete(w);
          if (!msg.ok) {
            fail(new Error(`hbc2js export: render worker failed: ${msg.error.message}${msg.error.stack ? `\n${msg.error.stack}` : ""}`));
            return;
          }
          for (const r of msg.results) results.set(r.moduleId, r.outcome);
          done += msg.results.length;
          onProgress?.(done);
          stats.peakWorkerHeap = Math.max(stats.peakWorkerHeap, msg.heap.total);
          heapOf.set(w, msg.heap.total);
          if (plan.budget !== null && !settled) {
            // The pool's footprint now: each live worker's last report (one
            // not yet reported counts as the largest seen), plus native.
            let footprint = 0;
            for (const x of workers) if (!retired.has(x)) footprint += (heapOf.get(x) ?? stats.peakWorkerHeap) + WORKER_NATIVE_BYTES;
            if (footprint > plan.budget && live > 1 && next < order.length) {
              // Over budget: retire this (now idle) worker; the rest carry on.
              retired.add(w);
              live--;
              void w.terminate().catch(() => undefined);
              finishIfDone();
              return;
            }
            const left = order.length - next;
            if (live < plan.max && footprint + stats.peakWorkerHeap + WORKER_NATIVE_BYTES <= plan.budget && left > live * BATCH * 4) feed(spawn());
          }
          feed(w);
        });
        w.once("error", (err) => {
          const batch = inflight.get(w);
          if ((err as NodeJS.ErrnoException).code === "ERR_WORKER_OUT_OF_MEMORY" && !unlimited.has(w) && batch !== undefined && !settled) {
            // A module bigger than the per-worker heap bound: redo its batch
            // on a worker without the bound (which then carries on with
            // the rest), instead of failing the export.
            retired.add(w);
            live--;
            const nw = spawn(false);
            inflight.set(nw, batch);
            nw.postMessage(batch);
            return;
          }
          fail(err);
        });
        w.once("exit", (code) => {
          if (!settled && !retired.has(w)) fail(new Error(`hbc2js export: render worker exited early with code ${code}`));
        });
        return w;
      };
      for (let i = 0; i < count; i++) spawn();
      for (const w of [...workers]) feed(w);
    });
  } finally {
    await Promise.all(workers.map((w) => w.terminate().catch(() => undefined)));
  }
  return results;
}
