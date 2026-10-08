
import { type AstNode, collectDeclaredNames, collectFreeReads, parseJs } from "../util/js-ast.ts";

const PRELUDE_GLOBALS: ReadonlySet<string> = new Set([
  // Metro's require runtime (require.js): installs these on `global`.
  "__d",
  "__r",
  "__c",
  "__registerSegment",
  "__accept",
  "__DEV__",
  "__METRO_GLOBAL_PREFIX__",
  "__BUNDLE_START_TIME__",
  "global",
  "globalThis",
  "self",
  "process",
  // RN/Hermes host bridge (InitializeCore.js, HermesInternal, the JSI proxy
  // objects a released Hermes VM installs before any JS runs).
  "nativeModuleProxy",
  "nativePerformanceNow",
  "nativeCallSyncHook",
  "nativeFlushQueueImmediate",
  "nativeLoggingHook",
  "nativeRequire",
  "__turboModuleProxy",
  "__fbBatchedBridge",
  "HermesInternal",
  "ErrorUtils",
  "RN$Bridgeless",
  // The implicit per-function `arguments` object — a real AST parses this as
  // a plain `Identifier` read like any other name, but it is bound by every
  // non-arrow function scope, never a free global.
  "arguments",
]);

const ECMA_BUILTINS: ReadonlySet<string> = new Set([
  "Object", "Array", "Function", "String", "Number", "Boolean", "Symbol",
  "Math", "JSON", "Date", "RegExp", "Error", "TypeError", "RangeError",
  "ReferenceError", "SyntaxError", "EvalError", "URIError", "AggregateError",
  "Promise", "Map", "Set", "WeakMap", "WeakSet", "WeakRef",
  "FinalizationRegistry", "Proxy", "Reflect", "ArrayBuffer", "SharedArrayBuffer",
  "DataView", "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array",
  "Uint16Array", "Int32Array", "Uint32Array", "Float32Array", "Float64Array",
  "BigInt", "BigInt64Array", "BigUint64Array", "Infinity", "NaN", "undefined",
  "isNaN", "isFinite", "parseInt", "parseFloat", "encodeURIComponent",
  "decodeURIComponent", "encodeURI", "decodeURI", "console", "structuredClone",
  "Iterator", "Generator", "GeneratorFunction", "AsyncFunction",
]);

/** hbc2js's own runtime-helper convention (`src/runtime/helpers.ts`,
 *  `src/export/registry.ts`'s `buildHelpersJs`): every exported tree
 *  installs the `__hbc_*` helpers a module body references as free globals
 *  onto `globalThis` from a separate, eagerly-required module. A name
 *  matching this prefix is provided by that prelude by construction, not by
 *  observation of this one bundle. */
function isHbcHelper(name: string): boolean {
  return name.startsWith("__hbc_");
}

function isAllowed(name: string): boolean {
  return PRELUDE_GLOBALS.has(name) || ECMA_BUILTINS.has(name) || isHbcHelper(name);
}

export interface CheckBundleOptions {
  /** Filesystem root `registerAsset` paths resolve against. Defaults to the
   *  bundle file's own directory (the common case: a combined bundle sits
   *  next to — or Metro built it from — the exported tree it came from). */
  readonly root?: string;
  /** Injected so tests don't touch the real filesystem for the asset check;
   *  production callers pass `existsSync`. */
  readonly fileExists: (path: string) => boolean;
}

export interface MissingRequire {
  readonly from: number;
  readonly to: number;
}

export interface FreeGlobal {
  readonly name: string;
  readonly modules: readonly number[];
}

export interface MissingAsset {
  readonly module: number;
  readonly httpServerLocation: string;
  readonly name: string;
  readonly type: string;
  readonly resolvedPath: string;
}

export interface CheckBundleResult {
  readonly ok: boolean;
  readonly modules: number;
  readonly missingRequires: readonly MissingRequire[];
  readonly duplicateIds: readonly number[];
  readonly freeGlobals: readonly FreeGlobal[];
  readonly missingAssets: readonly MissingAsset[];
}

interface DCall {
  readonly id: number;
  readonly factoryParamNames: ReadonlySet<string>;
  readonly requireParamName: string | undefined;
  readonly body: AstNode;
  readonly depMapIds: readonly number[];
}

function isAstNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as AstNode).type === "string";
}

/** `NumericLiteral`, or a unary `-`/`+` applied to one — the two shapes a
 *  bare integer literal can parse to. */
function numericLiteralValue(node: unknown): number | undefined {
  if (!isAstNode(node)) return undefined;
  if (node.type === "NumericLiteral") return node.value as number;
  if (node.type === "UnaryExpression" && (node.operator === "-" || node.operator === "+")) {
    const inner = numericLiteralValue(node.argument);
    if (inner === undefined) return undefined;
    return node.operator === "-" ? -inner : inner;
  }
  return undefined;
}

/** Every top-level `__d(...)` call anywhere in the parsed file (a bare
 *  `__d` identifier callee only — `x.__d(...)` or a shadowing local `__d`
 *  used unusually are never this pattern), parsed into id/params/body/deps.
 *  A call whose id or factory shape doesn't match the standard Metro form
 *  (a plain `function` expression, a literal integer id) is skipped, not
 *  registered — the standard form is what `hbc2js export` and every real
 *  Metro build observed so far produce; an unrecognised call is exactly the
 *  kind of thing a future worker adds a case for once a large bundle needs
 *  it, not a case to guess at now. */
function findDCalls(program: AstNode): DCall[] {
  const calls: DCall[] = [];
  const visit = (node: AstNode) => {
    if (node.type !== "CallExpression") return;
    const callee = node.callee;
    if (!isAstNode(callee) || callee.type !== "Identifier" || callee.name !== "__d") return;
    const args = node.arguments as unknown[];
    const factory = args[0];
    if (!isAstNode(factory) || factory.type !== "FunctionExpression") return;
    const id = numericLiteralValue(args[1]);
    if (id === undefined) return;
    const params = (factory.params as unknown[]) ?? [];
    const factoryParamNames = new Set<string>();
    for (const p of params) {
      if (isAstNode(p) && p.type === "Identifier") factoryParamNames.add(p.name as string);
    }
    const requireParamRaw = params[1];
    const requireParamName = isAstNode(requireParamRaw) && requireParamRaw.type === "Identifier" ? (requireParamRaw.name as string) : undefined;
    const depMapArg = args[2];
    const depMapIds: number[] = [];
    if (isAstNode(depMapArg) && depMapArg.type === "ArrayExpression") {
      for (const el of (depMapArg.elements as unknown[]) ?? []) {
        const n = numericLiteralValue(el);
        if (n !== undefined) depMapIds.push(n);
      }
    }
    calls.push({ id, factoryParamNames, requireParamName, body: factory.body as AstNode, depMapIds });
  };
  const stack: unknown[] = [program];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || node === undefined || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    if (!isAstNode(node)) continue;
    visit(node);
    for (const key of Object.keys(node)) {
      if (key === "start" || key === "end" || key === "loc" || key === "range" || key === "extra" || key === "tokens") continue;
      stack.push((node as Record<string, unknown>)[key]);
    }
  }
  return calls;
}

/** Every literal-argument call to the factory's own `require` parameter
 *  (`require(5)`) anywhere in `body`, including inside nested closures —
 *  same flattened scope `collectDeclaredNames`/`collectFreeReads` use. */
function findLiteralRequireTargets(body: AstNode, requireParamName: string | undefined): number[] {
  if (requireParamName === undefined) return [];
  const targets: number[] = [];
  const stack: unknown[] = [body];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || node === undefined || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    if (!isAstNode(node)) continue;
    if (node.type === "CallExpression") {
      const callee = node.callee;
      if (isAstNode(callee) && callee.type === "Identifier" && callee.name === requireParamName) {
        const arg0 = (node.arguments as unknown[])[0];
        const target = numericLiteralValue(arg0);
        if (target !== undefined) targets.push(target);
      }
    }
    for (const key of Object.keys(node)) {
      if (key === "start" || key === "end" || key === "loc" || key === "range" || key === "extra" || key === "tokens") continue;
      stack.push((node as Record<string, unknown>)[key]);
    }
  }
  return targets;
}

function stringLiteralValue(node: unknown): string | undefined {
  return isAstNode(node) && node.type === "StringLiteral" ? (node.value as string) : undefined;
}

/** Every `registerAsset({...})` call anywhere in `body` (bare or a `.`
 *  member call — Metro's own registry helper is invoked either way
 *  depending on how the caller imported it) whose object-literal argument
 *  names `httpServerLocation`/`name`/`type` as plain string properties —
 *  unlike the retired regex scanner, this reads the object's fields by
 *  their real AST shape, so a field order or an intervening nested object
 *  elsewhere in the literal can never desync which value is which. */
function findRegisterAssetCalls(body: AstNode): { readonly httpServerLocation: string; readonly name: string; readonly type: string }[] {
  const out: { readonly httpServerLocation: string; readonly name: string; readonly type: string }[] = [];
  const stack: unknown[] = [body];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || node === undefined || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    if (!isAstNode(node)) continue;
    if (node.type === "CallExpression") {
      const callee = node.callee;
      const isRegisterAsset =
        (isAstNode(callee) && callee.type === "Identifier" && callee.name === "registerAsset") ||
        (isAstNode(callee) &&
          callee.type === "MemberExpression" &&
          callee.computed !== true &&
          isAstNode(callee.property) &&
          callee.property.type === "Identifier" &&
          callee.property.name === "registerAsset");
      if (isRegisterAsset) {
        const obj = (node.arguments as unknown[])[0];
        if (isAstNode(obj) && obj.type === "ObjectExpression") {
          let httpServerLocation: string | undefined;
          let name: string | undefined;
          let type: string | undefined;
          for (const prop of (obj.properties as unknown[]) ?? []) {
            if (!isAstNode(prop) || prop.type !== "ObjectProperty" || prop.computed === true) continue;
            const key = prop.key;
            const keyName = isAstNode(key) ? (key.type === "Identifier" ? (key.name as string) : stringLiteralValue(key)) : undefined;
            if (keyName === "httpServerLocation") httpServerLocation = stringLiteralValue(prop.value);
            else if (keyName === "name") name = stringLiteralValue(prop.value);
            else if (keyName === "type") type = stringLiteralValue(prop.value);
          }
          if (httpServerLocation !== undefined && name !== undefined && type !== undefined) out.push({ httpServerLocation, name, type });
        }
      }
    }
    for (const key of Object.keys(node)) {
      if (key === "start" || key === "end" || key === "loc" || key === "range" || key === "extra" || key === "tokens") continue;
      stack.push((node as Record<string, unknown>)[key]);
    }
  }
  return out;
}

export async function checkBundle(text: string, options: CheckBundleOptions): Promise<CheckBundleResult> {
  const file = await parseJs(text);
  const program = (file as unknown as { program: AstNode }).program;
  const calls = findDCalls(program);
  const idCounts = new Map<number, number>();
  for (const c of calls) idCounts.set(c.id, (idCounts.get(c.id) ?? 0) + 1);
  const registered = idCounts;
  const duplicateIds = [...idCounts.entries()].filter(([, n]) => n > 1).map(([id]) => id).sort((a, b) => a - b);

  const missingRequires: MissingRequire[] = [];
  const seenPairs = new Set<string>();
  for (const c of calls) {
    const literalTargets = findLiteralRequireTargets(c.body, c.requireParamName);
    for (const to of [...c.depMapIds, ...literalTargets]) {
      if (registered.has(to)) continue;
      const key = `${c.id}->${to}`;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      missingRequires.push({ from: c.id, to });
    }
  }
  missingRequires.sort((a, b) => a.from - b.from || a.to - b.to);

  const freeGlobalModules = new Map<string, Set<number>>();
  for (const c of calls) {
    const declared = collectDeclaredNames(c.body);
    const reads = collectFreeReads(c.body);
    for (const name of reads) {
      if (c.factoryParamNames.has(name)) continue;
      if (declared.has(name)) continue;
      if (isAllowed(name)) continue;
      if (!freeGlobalModules.has(name)) freeGlobalModules.set(name, new Set());
      freeGlobalModules.get(name)!.add(c.id);
    }
  }
  const freeGlobals: FreeGlobal[] = [...freeGlobalModules.entries()]
    .map(([name, mods]) => ({ name, modules: [...mods].sort((a, b) => a - b) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const root = options.root ?? ".";
  const missingAssets: MissingAsset[] = [];
  for (const c of calls) {
    for (const asset of findRegisterAssetCalls(c.body)) {
      const rel = asset.httpServerLocation.replace(/^\/+/, "");
      const resolvedPath = joinPath(root, rel, `${asset.name}.${asset.type}`);
      if (!options.fileExists(resolvedPath)) {
        missingAssets.push({ module: c.id, httpServerLocation: asset.httpServerLocation, name: asset.name, type: asset.type, resolvedPath });
      }
    }
  }

  const ok = missingRequires.length === 0 && duplicateIds.length === 0 && freeGlobals.length === 0 && missingAssets.length === 0;
  return { ok, modules: calls.length, missingRequires, duplicateIds, freeGlobals, missingAssets };
}

/** POSIX-ish join good enough for the root/relative-folder/file shape above,
 *  without pulling in `node:path` — this module is pure text-in/data-out;
 *  `fileExists` is injected so it stays trivially unit-testable with no real
 *  disk, and the CLI wires the real `existsSync` (and does its own
 *  `node:path` join for the human-readable `--root` it was given). */
function joinPath(...parts: string[]): string {
  return parts
    .filter((p) => p.length > 0)
    .join("/")
    .replace(/\/+/g, "/");
}
