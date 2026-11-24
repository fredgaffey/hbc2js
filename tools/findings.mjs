#!/usr/bin/env node
// findings.mjs -- the one shared findings database for hbc2js bug hunting
// (sweeps, fuzzers, torture runs, benchmarks). Lives at /tmp/hbc2js/findings.sqlite
// next to this script. Node 22+ (node:sqlite).
//
//   node findings.mjs add --source fuzz --cluster <sig> --summary "..." [--app id]
//        [--hbc 96] [--module N] [--fn N] [--kind miscompile|syntax|free-ident|stub|crash|perf|other]
//        [--severity high|medium|low] [--repro path] [--detail '{"json":1}']
//   node findings.mjs list [--status open] [--cluster sig] [--source s] [--limit 50]
//   node findings.mjs clusters [--status open]      counts per cluster, ranked
//   node findings.mjs set-status <id|--cluster sig> <open|fixed|wontfix|duplicate|not-a-bug> [--note "..."]
//   node findings.mjs export-md                      markdown summary on stdout
//   node findings.mjs clear --source s --app a        delete that source's open rows for one app
//   node findings.mjs import <file.jsonl> --source s [--kind-map sweep]
//        bulk-insert one finding per JSONL line ({app, hbc, module?, fn, check,
//        sig, detail}, the tools/sweep/ schema) in one transaction; the sweep
//        kind/severity mapping is applied (see sweepKind below)
process.removeAllListeners("warning");
const { DatabaseSync } = await import("node:sqlite");
const { dirname, join } = await import("node:path");
const { fileURLToPath } = await import("node:url");

const DB = process.env.HBC2JS_FINDINGS_DB ?? join(dirname(fileURLToPath(import.meta.url)), "findings.sqlite");
const db = new DatabaseSync(DB);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;
CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY, ts TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT NOT NULL, app TEXT, hbc INTEGER, module INTEGER, fn INTEGER,
  kind TEXT NOT NULL DEFAULT 'other', severity TEXT NOT NULL DEFAULT 'medium',
  cluster TEXT NOT NULL, summary TEXT NOT NULL, repro TEXT, detail TEXT,
  status TEXT NOT NULL DEFAULT 'open', note TEXT);
CREATE INDEX IF NOT EXISTS f_cluster ON findings(cluster);
CREATE INDEX IF NOT EXISTS f_status ON findings(status);`);

const [cmd, ...rest] = process.argv.slice(2);
const flags = {}; const pos = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) { flags[rest[i].slice(2)] = rest[i + 1]; i++; } else pos.push(rest[i]);
}
const need = (k) => { if (flags[k] === undefined) { console.error(`missing --${k}`); process.exit(2); } return flags[k]; };
const num = (k) => (flags[k] === undefined ? null : Number(flags[k]));

switch (cmd) {
  case "add": {
    const r = db.prepare(`INSERT INTO findings (source, app, hbc, module, fn, kind, severity, cluster, summary, repro, detail)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(need("source"), flags.app ?? null, num("hbc"), num("module"), num("fn"),
      flags.kind ?? "other", flags.severity ?? "medium", need("cluster"), need("summary"), flags.repro ?? null, flags.detail ?? null);
    console.log(String(r.lastInsertRowid));
    break;
  }
  case "list": {
    const where = []; const args = [];
    for (const k of ["status", "cluster", "source", "app"]) if (flags[k]) { where.push(`${k}=?`); args.push(flags[k]); }
    const rows = db.prepare(`SELECT id, ts, source, app, hbc, module, fn, kind, severity, cluster, status, summary FROM findings
      ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ${Number(flags.limit ?? 50)}`).all(...args);
    for (const r of rows) console.log(`${r.id}\t${r.status}\t${r.severity}\t${r.kind}\t${r.cluster}\t${r.source}/${r.app ?? "-"}/hbc${r.hbc ?? "?"}\t${r.summary}`);
    break;
  }
  case "clusters": {
    const st = flags.status ?? "open";
    const rows = db.prepare(`SELECT cluster, kind, MAX(severity) sev, COUNT(*) n, COUNT(DISTINCT app) apps, GROUP_CONCAT(DISTINCT hbc) hbcs
      FROM findings WHERE status=? GROUP BY cluster ORDER BY n DESC`).all(st);
    for (const r of rows) console.log(`${r.n}\t${r.apps} apps\thbc ${r.hbcs ?? "?"}\t${r.kind}\t${r.cluster}`);
    break;
  }
  case "set-status": {
    const [idOrNothing, status] = flags.cluster ? [null, pos[0]] : [pos[0], pos[1]];
    if (!status) { console.error("usage: set-status <id|--cluster sig> <status>"); process.exit(2); }
    const r = flags.cluster
      ? db.prepare(`UPDATE findings SET status=?, note=COALESCE(?, note) WHERE cluster=?`).run(status, flags.note ?? null, flags.cluster)
      : db.prepare(`UPDATE findings SET status=?, note=COALESCE(?, note) WHERE id=?`).run(status, flags.note ?? null, Number(idOrNothing));
    console.log(`${r.changes} updated`);
    break;
  }
  case "export-md": {
    const rows = db.prepare(`SELECT cluster, kind, status, COUNT(*) n, COUNT(DISTINCT app) apps, MIN(summary) ex, MIN(repro) repro
      FROM findings GROUP BY cluster, status ORDER BY status, n DESC`).all();
    console.log("| status | count | apps | kind | cluster | example | repro |\n|---|---|---|---|---|---|---|");
    for (const r of rows) console.log(`| ${r.status} | ${r.n} | ${r.apps} | ${r.kind} | ${r.cluster} | ${String(r.ex).replace(/\|/g, "\\|")} | ${r.repro ?? ""} |`);
    break;
  }
  case "clear": { // drop one source's rows for one app before a re-import (sweep reruns)
    const r = db.prepare(`DELETE FROM findings WHERE source=? AND app=? AND status='open'`).run(need("source"), need("app"));
    console.log(`${r.changes} cleared`);
    break;
  }
  case "import": {
    const { readFileSync } = await import("node:fs");
    const src = need("source");
    const ins = db.prepare(`INSERT INTO findings (source, app, hbc, module, fn, kind, severity, cluster, summary, detail)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    let n = 0;
    db.exec("BEGIN");
    for (const line of readFileSync(pos[0], "utf8").split("\n")) {
      if (!line.trim()) continue;
      const f = JSON.parse(line);
      const [kind, severity] = sweepKind(f.check, f.sig);
      ins.run(src, f.app ?? null, f.hbc ?? null, typeof f.module === "number" ? f.module : f.module !== undefined && /^\d+$/.test(String(f.module)) ? Number(f.module) : null,
        f.fn ?? null, kind, severity, f.sig, `${f.check} fn#${f.fn}: ${String(f.detail ?? "").slice(0, 200)}`, JSON.stringify(f));
      n++;
    }
    db.exec("COMMIT");
    console.log(`${n} imported`);
    break;
  }
  default:
    console.log("commands: add, list, clusters, set-status, export-md (see header of this file)");
}

/** tools/sweep/ check -> (kind, severity). */
function sweepKind(check, sig) {
  switch (check) {
    case "PARSE": return ["syntax", "high"];
    case "FREE": return ["free-ident", /@|:<name>/.test(sig) && sig.includes("<name>") ? "medium" : "high"];
    case "TDZ": return ["miscompile", "high"];
    case "NEVER-WRITTEN": case "READ-BEFORE-WRITE": return ["miscompile", sig.endsWith(":deref") ? "high" : "low"];
    case "STUB": return ["stub", "medium"];
    case "FACTORY": case "CALL": return [sig.includes("ReferenceError") ? "crash" : "miscompile", "high"];
    case "WARN": return ["other", "low"];
    default: return ["other", "low"];
  }
}
