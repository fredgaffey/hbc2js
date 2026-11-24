#!/usr/bin/env node
// Aggregate sweep result dirs into markdown tables (counts per app, clusters
// ranked by count across apps, the W_* histogram).
//   node tools/sweep/report.mjs <out-root> [--top 40]
// <out-root>/<app>/{summary.json, findings.jsonl, factory-summary.json, factory-findings.jsonl}
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
const top = Number(process.argv[process.argv.indexOf("--top") + 1] || 40);
const readJ = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
const readL = (p) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

const apps = [];
const clusters = new Map(); // sig -> {n, fns:Set, apps:Map(app->n), hbcs:Set, ex}
const warn = new Map();
for (const d of readdirSync(root).sort()) {
  const s = readJ(join(root, d, "summary.json"));
  if (!s) continue;
  const fs = readJ(join(root, d, "factory-summary.json"));
  const all = [...readL(join(root, d, "findings.jsonl")), ...readL(join(root, d, "factory-findings.jsonl"))];
  const per = {};
  for (const f of all) {
    if (f.check === "WARN") continue;
    per[f.check] = (per[f.check] ?? 0) + 1;
    let c = clusters.get(f.sig);
    if (!c) clusters.set(f.sig, (c = { n: 0, fns: new Set(), apps: new Map(), hbcs: new Set(), ex: [] }));
    c.n++; c.fns.add(`${s.app}:${f.fn}`); c.apps.set(s.app, (c.apps.get(s.app) ?? 0) + 1); c.hbcs.add(f.hbc);
    if (c.ex.length < 2) c.ex.push(`${s.app} fn#${f.fn}${f.module !== undefined ? ` m${f.module}` : ""}${f.line ? ` L${f.line}` : ""}: ${String(f.detail).slice(0, 90)}`);
  }
  for (const [k, v] of Object.entries(s.warnHistogram ?? {})) {
    const w = warn.get(k) ?? {}; w[s.app] = v; warn.set(k, w);
  }
  apps.push({ s, fs, per });
}
const checks = ["PARSE", "FREE", "TDZ", "NEVER-WRITTEN", "READ-BEFORE-WRITE", "STUB", "FACTORY", "CALL"];
const out = [];
out.push("| app | hbc | functions | decompile s | " + checks.join(" | ") + " | modules (orig/dec) | factories threw (orig/dec) |");
out.push("|---|---|---|---|" + checks.map(() => "---").join("|") + "|---|---|");
for (const { s, fs, per } of apps) {
  out.push(`| ${s.app} | ${s.hbc} | ${s.functions} | ${Math.round(s.decompileMs / 1000)} | ${checks.map((c) => per[c] ?? 0).join(" | ")} | ${fs ? `${fs.modules.original ?? "-"}/${fs.modules.decompiled}` : "-"} | ${fs ? `${fs.threw.original ?? "-"}/${fs.threw.decompiled}` : "-"} |`);
}
out.push("", `### Clusters ranked by count (top ${top}; WARN excluded)`, "", "| # | count | fns | apps | hbc | signature | examples |", "|---|---|---|---|---|---|---|");
[...clusters.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, top).forEach(([sig, c], i) => {
  out.push(`| ${i + 1} | ${c.n} | ${c.fns.size} | ${[...c.apps].map(([a, n]) => `${a}:${n}`).join(" ")} | ${[...c.hbcs].sort().join(",")} | \`${sig.replace(/\|/g, "\\|")}\` | ${c.ex.join("<br>").replace(/\|/g, "\\|")} |`);
});
out.push("", "### W_* histogram (top 25, all apps)", "", "| code | " + apps.map((a) => a.s.app).join(" | ") + " |", "|---|" + apps.map(() => "---").join("|") + "|");
[...warn.entries()].map(([k, w]) => [k, w, Object.values(w).reduce((a, b) => a + b, 0)]).sort((a, b) => b[2] - a[2]).slice(0, 25)
  .forEach(([k, w]) => out.push(`| \`${k}\` | ${apps.map((a) => w[a.s.app] ?? 0).join(" | ")} |`));
console.log(out.join("\n"));
