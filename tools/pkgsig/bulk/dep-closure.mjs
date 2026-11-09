#!/usr/bin/env node
// deps-transitive-subtract (docs/DEPS.md "Transitive dependency subtraction"):
// write a sigdb layer's `dependency-closure.json` sidecar from the declared
// npm dependencies `dep-subtract.mjs` cached (`<name>@<version>.deps.json`,
// dependencies + peer + optional). Offline: never touches the registry.
//
// For every in-DB `name@version`, the closure is every declared dependency
// name, then transitively the declared dependencies of the in-DB version of
// that dependency which satisfies the declared range. A dependency with no
// satisfying in-DB version (or no cached metadata) is named but not
// descended into: a different version's edges are not evidence (they made
// which-typed-array and is-typed-array each other's dependency).
//
//   node tools/pkgsig/bulk/dep-closure.mjs <dbDir> --cache-dir <dir>[,<dir>...] [--out <file>]
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDependencyVersion } from "./dep-subtract.mjs";

/** `{ "<name>@<version>": { dep: range } }` -> `{ "<name>@<version>": [names] }`.
 *  `versions` maps a package name to its in-DB versions. Pure. */
export function dependencyClosures(declared, versions) {
  const direct = (key) => declared[key] ?? null;
  const out = {};
  for (const key of Object.keys(declared)) {
    const self = key.slice(0, key.lastIndexOf("@"));
    const names = new Set();
    const seen = new Set([key]);
    const stack = [key];
    while (stack.length > 0) {
      const deps = direct(stack.pop());
      if (deps === null) continue;
      for (const [name, range] of Object.entries(deps)) {
        if (name === self) continue;
        names.add(name);
        let v = null;
        try { v = resolveDependencyVersion(String(range), versions.get(name) ?? []); } catch { v = null; }
        const next = v === null ? null : `${name}@${v}`;
        if (next !== null && !seen.has(next)) { seen.add(next); stack.push(next); }
      }
    }
    if (names.size > 0) out[key] = [...names].sort();
  }
  return out;
}

const fileKey = (f) => {
  const base = f.replace(/__hbc\d+\.json$/, "");
  const at = base.lastIndexOf("@");
  return at <= 0 ? null : { name: base.slice(0, at).replace(/__/g, "/"), version: base.slice(at + 1) };
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const dbDir = args[0];
  const ci = args.indexOf("--cache-dir");
  const oi = args.indexOf("--out");
  if (dbDir === undefined || ci < 0) {
    console.error("usage: dep-closure.mjs <dbDir> --cache-dir <dir>[,<dir>...] [--out <file>]");
    process.exit(2);
  }
  const caches = args[ci + 1].split(",");
  const versions = new Map();
  const declared = {};
  for (const f of readdirSync(dbDir)) {
    if (!/__hbc\d+\.json$/.test(f)) continue;
    const k = fileKey(f);
    if (k === null) continue;
    const key = `${k.name}@${k.version}`;
    if (!versions.has(k.name)) versions.set(k.name, []);
    if (!versions.get(k.name).includes(k.version)) versions.get(k.name).push(k.version);
    if (key in declared) continue;
    const doc = `${k.name.replace(/\//g, "__")}@${k.version}.deps.json`;
    const hit = caches.map((c) => join(c, doc)).find((p) => existsSync(p));
    if (hit === undefined) continue;
    try { declared[key] = JSON.parse(readFileSync(hit, "utf8")); } catch { /* unreadable cache entry: no edges */ }
  }
  const closures = dependencyClosures(declared, versions);
  const out = oi >= 0 ? args[oi + 1] : join(dbDir, "dependency-closure.json");
  writeFileSync(out, JSON.stringify(closures));
  console.error(`dep-closure: ${Object.keys(declared).length} with metadata, ${Object.keys(closures).length} closures -> ${out}`);
}
