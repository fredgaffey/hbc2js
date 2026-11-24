// Runs export's offline deps stage (`runDeps(bundle, { offline: true })`) on
// a worker thread so it overlaps the main thread's split instead of
// following it: the two only meet at `segregateSplitTree`. The report is
// plain JSON data (it is what `hbc2js deps --json` prints), so it crosses
// the thread boundary unchanged.
import { parentPort, workerData } from "node:worker_threads";
import { runDeps } from "../deps/index.ts";
import { enableProgress } from "../util/progress.ts";

const data = workerData as { readonly bundlePath: string; readonly progress: boolean };
if (data.progress) enableProgress("export");
runDeps(data.bundlePath, { offline: true }).then(
  (r) => parentPort!.postMessage({ ok: true, report: r.report }),
  (e: unknown) => {
    const err = e as { message?: string; code?: string };
    parentPort!.postMessage({ ok: false, message: err.message ?? String(e), ...(typeof err.code === "string" ? { code: err.code } : {}) });
  },
);
