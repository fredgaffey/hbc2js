// Export safety net (docs/BUGS.md `for-of-noreturn-handler-label`): every
// module file export writes is parsed before it is written. A file that does
// not parse is a hard Metro failure for the whole app (`SyntaxError ...
// Unsyntactic break`), so `exportProject` drops that module down the §7.3
// ladder (readable -> flat -> stub) instead, and records why in EXPORT.json.
//
// `@babel/parser` (a runtime dependency) rather than `vm.Script`: the `jsx`
// tier writes JSX, which `vm.Script` cannot parse. Parse only -- no
// traversal, no tokens -- so the cost is one linear pass per file.

/** `null` when `code` parses, else the parser's message (with its location). */
export type ModuleSyntaxCheck = (code: string, path: string) => string | null;

const PLUGINS = [
  "jsx",
  "classProperties",
  "classPrivateProperties",
  "classPrivateMethods",
  "classStaticBlock",
  "optionalChaining",
  "nullishCoalescingOperator",
  "objectRestSpread",
  "dynamicImport",
  "numericSeparator",
  "logicalAssignment",
  "bigInt",
] as const;

type BabelParse = (code: string, options: Record<string, unknown>) => unknown;

export async function loadModuleSyntaxCheck(): Promise<ModuleSyntaxCheck> {
  const { parse } = (await import("@babel/parser")) as unknown as { parse: BabelParse };
  return (code) => {
    try {
      parse(code, { sourceType: "script", allowReturnOutsideFunction: true, errorRecovery: false, tokens: false, plugins: PLUGINS });
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
}

/** Rung 3's last resort for a module whose every render failed the check:
 *  loader-shaped (`__d(factory, id, deps)`, the shape `rewriteModuleFile`
 *  consumes) and throws on first require, naming the reason. */
export function syntaxStubFlatText(id: number, deps: readonly number[], reason: string): string {
  const msg = JSON.stringify(`hbc2js: module ${id} could not be exported as valid JavaScript (${reason})`);
  return `// hbc2js export -- module ${id}: no render passed the syntax check\nfunction factory(global, require, importDefault, importAll, module, exports, dependencyMap) {\n  throw new Error(${msg});\n}\n__d(factory, ${id}, ${JSON.stringify(deps)});\n`;
}
