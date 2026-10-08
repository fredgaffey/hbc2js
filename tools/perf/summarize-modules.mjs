#!/usr/bin/env node
//   node tools/perf/summarize-modules.mjs <dump> <artifact-index.json> [topN=25]
//
// <dump> is a captured console/logcat/os_log stream containing
// `__HBC_BOOT_TIMING__ {"id":..,"t0":..,"dt":..}` lines (or bare JSON lines,
// one record per line -- either shape is accepted, same "regex doesn't care
// what wraps the line" convention as the device tool's own marker parser).
//
// Prints self time (ms) and package per module id, sorted descending, same
// output style as tools/perf/summarize-cpuprofile.mjs. A module id the
// index cannot attribute to a package is printed as "unknown" and counted
// in the totals -- never dropped (same contract as check-bundle/sizediff/
// seams's own unmatched-row handling).
import { readFileSync } from "node:fs";

/** The console marker `buildRegistryJs`'s flush emits before each record's
 *  JSON. A bare JSON line (no marker) is also accepted, e.g. when a caller
 *  read `globalThis.__HBC_BOOT_TIMINGS__` directly and serialised each
 *  record itself instead of going through the console flush. */
export const BOOT_TIMING_MARKER = "__HBC_BOOT_TIMING__";
const MARKER_LINE_RE = /__HBC_BOOT_TIMING__\s*(\{.*\})\s*$/;

/** Parses a captured dump into `{id, t0, dt}` records, skipping any line
 *  that is not one of the two accepted shapes (blank lines, unrelated log
 *  noise, a logcat/os_log tag+timestamp prefix around the marker) rather
 *  than failing the whole dump over one bad line. */
export function parseDump(text) {
  const records = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const markerMatch = MARKER_LINE_RE.exec(line);
    const jsonText = markerMatch ? markerMatch[1] : line;
    let rec;
    try {
      rec = JSON.parse(jsonText);
    } catch {
      continue;
    }
    if (rec && typeof rec === "object" && typeof rec.id === "number" && typeof rec.t0 === "number" && typeof rec.dt === "number") {
      records.push({ id: rec.id, t0: rec.t0, dt: rec.dt });
    }
  }
  return records;
}

export function loadArtifactIndex(indexJson) {
  const byId = new Map();
  for (const m of indexJson.modules ?? []) {
    if (typeof m.id !== "number") continue;
    byId.set(m.id, {
      owner: typeof m.owner === "string" ? m.owner : null,
      bucket: typeof m.bucket === "string" ? m.bucket : null,
      path: typeof m.path === "string" ? m.path : null,
    });
  }
  return byId;
}

export function packageFor(index, id) {
  const entry = index.get(id);
  if (entry === undefined) return "unknown";
  if (entry.owner !== null) return entry.owner;
  if (entry.bucket !== null) return entry.bucket;
  return "unknown";
}

/** Self time per module id: `dt` measures the WHOLE factory call, which
 *  includes any nested module's own factory time (a dependency `require()`d
 *  during this module's init runs, and is itself timed, INSIDE this
 *  window) -- so self time is `dt` minus every directly-nested record's own
 *  `dt`, not `dt` itself. Since module registration is a plain synchronous
 *  CommonJS call tree (one JS thread, no concurrent factories), any two
 *  intervals `[t0, t0+dt)` are either disjoint or properly nested -- never
 *  partially overlapping -- so a classic flame-graph stack walk (sort by
 *  `t0`, push/pop by containment) computes exact self time with no need to
 *  know the caller/callee relationship explicitly. Records sharing the same
 *  id (module required more than once across a dump spanning multiple
 *  boots) have their self times summed. */
export function computeSelfTimes(records) {
  const sorted = records.map((r, i) => ({ ...r, _order: i })).sort((a, b) => a.t0 - b.t0 || a._order - b._order);
  const selfById = new Map();
  const stack = [];
  const finalize = (frame) => {
    const self = Math.max(frame.rec.dt - frame.childTime, 0);
    selfById.set(frame.rec.id, (selfById.get(frame.rec.id) ?? 0) + self);
    if (stack.length > 0) stack[stack.length - 1].childTime += frame.rec.dt;
  };
  for (const rec of sorted) {
    const end = rec.t0 + rec.dt;
    while (stack.length > 0 && stack[stack.length - 1].end <= rec.t0) finalize(stack.pop());
    stack.push({ rec, end, childTime: 0 });
  }
  while (stack.length > 0) finalize(stack.pop());
  return selfById;
}

/** Builds the sorted, package-attributed report `printReport` prints.
 *  `unattributedSelfMs`/`unattributedModuleCount` are always present, even
 *  when zero, so a caller never has to guess whether "no unknown rows"
 *  means "fully attributed" or "field omitted". */
export function summarizeModules(records, index, topN = 25) {
  const selfById = computeSelfTimes(records);
  const rows = [];
  for (const [id, selfMs] of selfById) {
    const entry = index.get(id);
    rows.push({ id, selfMs, package: packageFor(index, id), path: entry?.path ?? null });
  }
  rows.sort((a, b) => b.selfMs - a.selfMs || a.id - b.id);
  const totalMs = rows.reduce((sum, r) => sum + r.selfMs, 0);
  const unattributed = rows.filter((r) => r.package === "unknown");
  return {
    rows,
    top: rows.slice(0, topN),
    totalMs,
    moduleCount: rows.length,
    unattributedModuleCount: unattributed.length,
    unattributedSelfMs: unattributed.reduce((sum, r) => sum + r.selfMs, 0),
  };
}

/** Same output style as `summarize-cpuprofile.mjs`: one totals line, a
 *  blank line, a tab-separated header + rows. */
export function formatReport(summary) {
  const lines = [];
  lines.push(
    `total self time: ${summary.totalMs.toFixed(1)} ms, ${summary.moduleCount} module(s) timed, ` +
      `${summary.unattributedModuleCount} unattributed (unknown package, ${summary.unattributedSelfMs.toFixed(1)} ms)`,
  );
  lines.push("");
  lines.push("self_ms\tid\tpackage\tpath");
  for (const r of summary.top) {
    lines.push(`${r.selfMs.toFixed(1)}\t${r.id}\t${r.package}\t${r.path ?? ""}`);
  }
  return lines.join("\n");
}

async function main(argv) {
  const [dumpPath, indexPath, topNArg] = argv;
  if (!dumpPath || !indexPath) {
    console.error("usage: summarize-modules.mjs <dump> <artifact-index.json> [topN]");
    return 1;
  }
  const topN = topNArg ? Number(topNArg) : 25;
  const records = parseDump(readFileSync(dumpPath, "utf8"));
  const index = loadArtifactIndex(JSON.parse(readFileSync(indexPath, "utf8")));
  const summary = summarizeModules(records, index, topN);
  console.log(formatReport(summary));
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
