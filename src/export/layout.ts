// src/export/layout.ts — docs/specs/29-export.md §3.1/§3.2: the one function
// that turns a module id into an export-tree path. Built on top of
// `segregateSplitTree`'s own `SegregatedModuleInfo.newPath` (spec 08), never
// re-deriving the src/ vs library classification itself — this module only
// re-roots the `node_modules/` buckets `export` is not allowed to write into
// (§3.1: `npm install` owns that directory).
import type { SegregatedModuleInfo } from "../split/segregate.ts";

export type ExportBucket = "app" | "vendor" | "unclassified";

export interface ExportModuleInfo {
  readonly id: number;
  /** POSIX path, relative to the export tree root (e.g. `"src/App.js"`,
   *  `"src/_vendor/react/module_5.js"`, `"src/_unclassified/module_9.js"`). */
  readonly path: string;
  readonly bucket: ExportBucket;
  readonly package: string | null;
}

const ANON_VENDOR_RE = /^node_modules\/_vendor\/module_(\d+)\.js$/;

/** §3.1's re-rooting table, applied to one `SegregatedModuleInfo`. Belt and
 *  braces for a bucket `segregateSplitTree` cannot produce today (spec 08 §4
 *  guarantees coverage) is the caller's job (§3.2 step 2), not this
 *  function's — `exportPathForModule` only rewrites paths segregate did
 *  hand back. */
export function exportPathForModule(info: SegregatedModuleInfo): ExportModuleInfo {
  if (info.bucket === "node_modules") {
    if (ANON_VENDOR_RE.test(info.newPath)) {
      return { id: info.id, path: `src/_vendor/_anon/module_${info.id}.js`, bucket: "vendor", package: null };
    }
    // `node_modules/<pkg>/module_N.js` (pkg may itself contain a `/` for a
    // scoped package, e.g. `@babel/runtime` — `packageDirName` in
    // segregate.ts already returns the package name unchanged) ->
    // `src/_vendor/<pkg>/module_N.js`.
    const rest = info.newPath.slice("node_modules/".length);
    return { id: info.id, path: `src/_vendor/${rest}`, bucket: "vendor", package: info.package };
  }
  if (info.bucket === "unclassified") {
    return { id: info.id, path: `src/_unclassified/module_${info.id}.js`, bucket: "unclassified", package: null };
  }
  // bucket === "src": unchanged.
  return { id: info.id, path: info.newPath, bucket: "app", package: null };
}

/** POSIX-relative require specifier from `fromPath` (a file's own path,
 *  relative to the export tree root) to `toPath` (another file's path),
 *  always `./`- or `../`-prefixed — Metro treats a bare specifier as a
 *  package name (spec 29 §3.2), so an edge within the tree must never
 *  produce one. */
export function relativeExportPath(fromPath: string, toPath: string): string {
  const fromDir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  const fromParts = fromDir === "" ? [] : fromDir.split("/");
  const toParts = toPath.split("/");
  let i = 0;
  while (i < fromParts.length && i < toParts.length - 1 && fromParts[i] === toParts[i]) i++;
  const ups = fromParts.length - i;
  const downs = toParts.slice(i);
  const rel = [...Array(ups).fill(".."), ...downs].join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}
