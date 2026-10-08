import { parentPort, workerData } from "node:worker_threads";
import { ArtifactService } from "../artifact/service.ts";
import { computeLeads, type LeadsResult } from "../mcp/leads.ts";

/** `workerData` shape `runLeadsWorker` (`src/ui-server/list.ts`) sends.
 *  `computeLeads` reads only `native`/`stringUses`/`globalUses` — never
 *  `source(fn)` — so, like `segregationOf`, this never needs the `.hbc`
 *  path `ArtifactService`'s `opts.hbc` would otherwise carry. */
export interface LeadsWorkerInput {
  readonly artifactDir: string;
}

export type LeadsWorkerMessage = { readonly ok: true; readonly result: LeadsResult } | { readonly ok: false; readonly error: string };

if (parentPort !== null) {
  const input = workerData as LeadsWorkerInput;
  try {
    const artifact = new ArtifactService(input.artifactDir);
    const result = computeLeads(artifact);
    const msg: LeadsWorkerMessage = { ok: true, result };
    parentPort.postMessage(msg);
  } catch (err) {
    const msg: LeadsWorkerMessage = { ok: false, error: err instanceof Error ? err.message : String(err) };
    parentPort.postMessage(msg);
  }
}
