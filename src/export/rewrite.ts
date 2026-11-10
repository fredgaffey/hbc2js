// src/export/rewrite.ts — docs/specs/29-export.md §4.4: turns one split-tree
// module file into an export-tree module file. Two rewrites plus one
// addition, applied to the same body text `splitProject` already produced
// (never re-decompiled):
//   1. the trailing `__d(factory, id, deps)` becomes `__hbc.define(...)`,
//      fed by a `require("<relative path>/_hbc/registry.js")` at the top;
//   2. every body-level `require('./module_N.js')` (src/split/rewrite.ts's
//      own literal call sites) becomes `__hbc.r(N)` — a numeric id call, so
//      module-level cycles behave exactly as they did in the original bundle
//      (§4.4 point 2);
//   3. one literal `require("<relative path>")` per dependency edge is
//      appended after `define` runs, so Metro's static resolver sees the
//      edge even though `__hbc.r` is what actually runs it (§4.4 point 3).
import { relativeExportPath } from "./layout.ts";

const BODY_REQUIRE_RE = /require\((['"])\.\/module_(\d+)\.js\1\)/g;
const TRAILING_DEFINE_RE = /\n__d\(factory, (\d+), (\[[^\]]*\])\);\n?$/;
const HEADER_RE = /^\/\/ hbc2js --split[^\n]*\n/;

export interface RewriteModuleFileOptions {
  /** This module's own export-tree path (relative to the tree root). */
  readonly path: string;
  /** `src/_hbc/registry.js`'s export-tree path. */
  readonly registryPath: string;
  /** id -> export-tree path, for every id this module or any other module
   *  depends on (only this module's own `deps` entries are looked up). */
  readonly pathOf: (id: number) => string;
  readonly tier: string;
  readonly bucket: string;
  readonly factoryFunctionIndex: number;
  /** §5.2's boundary-target map (`src/export/substitute.ts`): a dependency id
   *  present here gets a bare `require("<package>")` trailing registration
   *  instead of a relative path -- the file at `pathOf(id)` no longer exists
   *  (deleted along with the rest of that package's `own(P)`). Empty map
   *  (default) reproduces 6a/6b's un-substituted behaviour exactly. */
  readonly boundaryPackage?: ReadonlyMap<number, string>;
}

export interface RewriteModuleFileResult {
  readonly text: string;
  /** Count of body-level `require('./module_N.js')` call sites rewritten to
   *  `__hbc.r(N)` (spec 29 §4.4 point 2's own count, reported in the
   *  manifest by a later item — kept here so nothing has to re-scan). */
  readonly edgesRewritten: number;
}

/** Rewrites one split-tree module file's text into its export-tree shape.
 *  Throws (not a silent pass-through) if the trailing `__d(factory, id,
 *  deps)` call this function depends on is missing — every file
 *  `splitProject` writes has exactly this shape (see `src/split/index.ts`),
 *  so its absence means the input was not what this function expects, not a
 *  case to guess through. */
export function rewriteModuleFile(originalText: string, id: number, opts: RewriteModuleFileOptions): RewriteModuleFileResult {
  const withoutHeader = originalText.replace(HEADER_RE, "");
  const m = TRAILING_DEFINE_RE.exec(withoutHeader);
  if (m === null) {
    throw new Error(`export: module ${id}'s split file has no trailing __d(factory, ...) call to rewrite`);
  }
  const declaredId = Number(m[1]);
  if (declaredId !== id) {
    throw new Error(`export: module ${id}'s split file declares __d(factory, ${declaredId}, ...) — id mismatch`);
  }
  const deps = JSON.parse(m[2]!) as number[];

  let edgesRewritten = 0;
  const body = withoutHeader.slice(0, m.index).replace(BODY_REQUIRE_RE, (_all, _q, depIdStr: string) => {
    edgesRewritten++;
    return `__hbc.r(${depIdStr})`;
  });

  const registryRequire = relativeExportPath(opts.path, opts.registryPath);
  const header = `// hbc2js export -- module ${id} (tier: ${opts.tier}; source fn#${opts.factoryFunctionIndex}; ${opts.bucket})\n`;
  const requireHbc = `var __hbc = require(${JSON.stringify(registryRequire)});\n`;
  const define = `__hbc.define(factory, ${id}, ${JSON.stringify(deps)});\n`;
  const registrations = deps
    .map((depId) => `require(${JSON.stringify(registrationSpecifier(depId, opts))});`)
    .join("\n");

  const text = `${header}${requireHbc}${body}\n${define}${registrations.length > 0 ? `${registrations}\n` : ""}`;
  return { text, edgesRewritten };
}

/** One dependency's trailing registration specifier (spec §4.4 point 3): a
 *  bare package name when `depId` is a substituted package's boundary
 *  module (§5.2), else the relative path `pathOf` already resolves. Shared
 *  by `rewriteModuleFile` and `wrapReadableModule` so the two rendering
 *  paths (flat text vs. `renderModuleReadable` output) never diverge on
 *  this. */
function registrationSpecifier(depId: number, opts: Pick<RewriteModuleFileOptions, "path" | "pathOf" | "boundaryPackage">): string {
  const pkg = opts.boundaryPackage?.get(depId);
  if (pkg !== undefined) return pkg;
  return relativeExportPath(opts.path, opts.pathOf(depId));
}

const READABLE_FUNC_DECL_RE = /^function\s+((?!__hbc_)[\w$]+)\s*\(/m; // never a hoisted runtime helper

export interface WrapReadableModuleOptions {
  readonly path: string;
  readonly registryPath: string;
  readonly pathOf: (id: number) => string;
  readonly tier: string;
  readonly bucket: string;
  readonly factoryFunctionIndex: number;
  /** See `RewriteModuleFileOptions.boundaryPackage`. */
  readonly boundaryPackage?: ReadonlyMap<number, string>;
}

export function wrapReadableModule(code: string, id: number, deps: readonly number[], opts: WrapReadableModuleOptions): { readonly text: string } {
  // The factory is `_fn<factoryFunctionIndex>`. The FIRST declaration is not
  // always it: the scoped render hoists runtime helpers (`__hbc_pnames` for
  // for-in) above the factory, and registering a helper as the factory ran
  // the helper instead (spec 33 L1, rn-template module 59).
  const m = new RegExp(`^function\\s+(_fn${opts.factoryFunctionIndex})\\s*\\(`, "m").exec(code) ?? READABLE_FUNC_DECL_RE.exec(code);
  if (m === null) {
    throw new Error(`export: module ${id}'s readable render has no top-level function declaration to wrap`);
  }
  const functionName = m[1]!;
  const registryRequire = relativeExportPath(opts.path, opts.registryPath);
  const header = `// hbc2js export -- module ${id} (tier: ${opts.tier}; source fn#${opts.factoryFunctionIndex}; ${opts.bucket})\n`;
  const requireHbc = `var __hbc = require(${JSON.stringify(registryRequire)});\n`;
  const define = `__hbc.define(${functionName}, ${id}, ${JSON.stringify(deps)});\n`;
  const registrations = deps
    .map((depId) => `require(${JSON.stringify(registrationSpecifier(depId, opts))});`)
    .join("\n");
  const text = `${header}${requireHbc}${code}\n${define}${registrations.length > 0 ? `${registrations}\n` : ""}`;
  return { text };
}
