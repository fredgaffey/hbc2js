// This is deliberately NOT a full `@babel/traverse`-style scope-aware
// binder: only `@babel/parser` is a declared dependency here (it is already
// present transitively via the RN/Metro devDependencies at the exact pinned
// version, same reasoning that applied to `@babel/parser` itself before this
// landing), so traversal and "is this identifier a free read" analysis are
// hand-written over the raw AST shape `@babel/parser` produces (Babel's own
// AST, a superset of ESTree). This trades a little more code here for one
// fewer dependency to justify.

/** A loosely-typed Babel AST node. Precise per-node-type fields aren't
 *  declared (that would need `@babel/types`, not a declared dependency
 *  here) -- callers narrow on `.type` themselves, same convention as
 *  hand-rolling this over plain `JSON`-shaped data. */
export interface AstNode {
  readonly type: string;
  readonly [key: string]: unknown;
}

type BabelParseFn = (code: string, options: Record<string, unknown>) => AstNode;

let cachedParse: BabelParseFn | undefined;

async function loadParser(): Promise<BabelParseFn> {
  if (cachedParse !== undefined) return cachedParse;
  let mod: { parse: BabelParseFn };
  try {
    // Dynamic on purpose -- see the module doc comment. `@babel/parser` is a
    // devDependency (package.json), not a runtime one.
    mod = (await import("@babel/parser")) as unknown as { parse: BabelParseFn };
  } catch {
    throw new Error(
      "hbc2js's dev-loop tooling (check-bundle/sizediff) needs the '@babel/parser' " +
        "devDependency, which isn't installed here. Run `npm install` from the repo root, then retry.",
    );
  }
  cachedParse = mod.parse;
  return cachedParse;
}

/** Syntax `@babel/parser` doesn't enable by default that a real Metro bundle
 *  or hbc2js's own rendered output can plausibly contain. Not Flow/JSX --
 *  those are F5's concern (seams' variant-source pipeline), never plain
 *  bundle/decompiled text. */
const DEFAULT_PLUGINS = [
  "classProperties",
  "classPrivateProperties",
  "classPrivateMethods",
  "classStaticBlock",
  "optionalChaining",
  "nullishCoalescingOperator",
  "objectRestSpread",
  "dynamicImport",
  "exportDefaultFrom",
  "numericSeparator",
  "logicalAssignment",
  "topLevelAwait",
  "bigInt",
] as const;

/** Parses `code` into a Babel `File` AST node (`.program` is the top-level
 *  `Program` node, `.comments` every comment). `sourceType: "unambiguous"`
 *  lets Babel decide script vs module itself rather than this module
 *  guessing -- a Metro combined bundle is CommonJS-shaped and never
 *  legitimately has top-level `import`/`export`, but staying permissive
 *  costs nothing here. Throws a `SyntaxError`-derived error (from
 *  `@babel/parser` itself) on unparseable input; callers report that as a
 *  measurement failure, same as every other tool in this lane. */
export async function parseJs(code: string): Promise<AstNode> {
  const parse = await loadParser();
  return parse(code, {
    sourceType: "unambiguous",
    allowReturnOutsideFunction: true,
    errorRecovery: false,
    plugins: DEFAULT_PLUGINS,
  });
}

function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as AstNode).type === "string";
}

const WALK_SKIP_KEYS = new Set(["type", "start", "end", "loc", "range", "extra", "tokens", "leadingComments", "trailingComments", "innerComments"]);

/** Generic pre-order walk of every AST node reachable from `root` (arrays
 *  and nested nodes alike), skipping position/comment metadata. `visit`
 *  cannot stop the descent (every reachable node is visited) -- callers that
 *  need to skip a subtree (e.g. "don't look inside a nested function") do
 *  their own recursion instead of this generic helper (see
 *  `collectDeclaredNames`'s module doc comment for why that one doesn't need
 *  to). */
export function walk(root: unknown, visit: (node: AstNode) => void): void {
  if (root === null || root === undefined || typeof root !== "object") return;
  if (Array.isArray(root)) {
    for (const item of root) walk(item, visit);
    return;
  }
  if (!isNode(root)) return;
  visit(root);
  for (const key of Object.keys(root)) {
    if (WALK_SKIP_KEYS.has(key)) continue;
    walk((root as Record<string, unknown>)[key], visit);
  }
}

/** Every name a binding PATTERN (`Identifier`, `ObjectPattern`,
 *  `ArrayPattern`, `AssignmentPattern`, `RestElement`) introduces, added to
 *  `out`. A default value (`AssignmentPattern.right`, e.g. the `b` in
 *  `{a = b}`) is a READ, not a binding -- deliberately NOT walked here (the
 *  hand-rolled scanner's regex-based param-list sweep couldn't tell the two
 *  apart and silently treated a destructuring/parameter default's own free
 *  variable as "declared"; that false negative is what `collectFreeReads`
 *  below fixes). */
export function patternBoundNames(pattern: unknown, out: Set<string>): void {
  if (!isNode(pattern)) return;
  switch (pattern.type) {
    case "Identifier":
      out.add(pattern.name as string);
      return;
    case "ObjectPattern":
      for (const prop of (pattern.properties as unknown[]) ?? []) {
        if (!isNode(prop)) continue;
        if (prop.type === "RestElement") patternBoundNames(prop.argument, out);
        else patternBoundNames(prop.value, out); // ObjectProperty: key is not a binding
      }
      return;
    case "ArrayPattern":
      for (const el of (pattern.elements as unknown[]) ?? []) patternBoundNames(el, out);
      return;
    case "AssignmentPattern":
      patternBoundNames(pattern.left, out);
      return;
    case "RestElement":
      patternBoundNames(pattern.argument, out);
      return;
    default:
      return;
  }
}

const DECLARING_FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ObjectMethod", "ClassMethod", "ClassPrivateMethod"]);

/** Every name bound ANYWHERE in the subtree rooted at `root` -- function/
 *  class names, every parameter (via `patternBoundNames`, so destructuring
 *  and rest params are covered), every `var`/`let`/`const` declarator, catch
 *  clause bindings, import bindings. Deliberately function-wide, not
 *  block/nested-function-scoped (a name declared inside a NESTED closure
 *  still counts as "declared" for the whole subtree) -- same over-inclusive
 *  direction the hand-rolled scanner's `declaredNames` documented: this
 *  tool would rather miss a genuinely free variable shadowed by a same-named
 *  nested local than ever report a real local as a false "free global". */
export function collectDeclaredNames(root: unknown): Set<string> {
  const out = new Set<string>();
  walk(root, (n) => {
    switch (n.type) {
      case "VariableDeclarator":
        patternBoundNames(n.id, out);
        return;
      case "ArrowFunctionExpression":
        for (const p of (n.params as unknown[]) ?? []) patternBoundNames(p, out);
        return;
      case "ClassDeclaration":
      case "ClassExpression": {
        const id = n.id;
        if (isNode(id) && typeof id.name === "string") out.add(id.name);
        return;
      }
      case "CatchClause":
        if (n.param !== null && n.param !== undefined) patternBoundNames(n.param, out);
        return;
      case "ImportSpecifier":
      case "ImportDefaultSpecifier":
      case "ImportNamespaceSpecifier":
        patternBoundNames(n.local, out);
        return;
      default:
        if (DECLARING_FUNCTION_TYPES.has(n.type)) {
          const id = n.id;
          if (isNode(id) && typeof id.name === "string") out.add(id.name);
          for (const p of (n.params as unknown[]) ?? []) patternBoundNames(p, out);
        }
        return;
    }
  });
  return out;
}

/** Recurses through a binding PATTERN, feeding every non-binding
 *  sub-expression it contains (a default value, a computed object-pattern
 *  key) to `onRead` as a read -- the counterpart to `patternBoundNames`
 *  skipping exactly those same positions. */
function walkPatternReads(pattern: unknown, onRead: (node: AstNode) => void, visitExpr: (node: unknown) => void): void {
  if (!isNode(pattern)) return;
  switch (pattern.type) {
    case "Identifier":
      return; // a binding, not a read
    case "ObjectPattern":
      for (const prop of (pattern.properties as unknown[]) ?? []) {
        if (!isNode(prop)) continue;
        if (prop.type === "RestElement") walkPatternReads(prop.argument, onRead, visitExpr);
        else {
          if (prop.computed === true) visitExpr(prop.key);
          walkPatternReads(prop.value, onRead, visitExpr);
        }
      }
      return;
    case "ArrayPattern":
      for (const el of (pattern.elements as unknown[]) ?? []) walkPatternReads(el, onRead, visitExpr);
      return;
    case "AssignmentPattern":
      walkPatternReads(pattern.left, onRead, visitExpr);
      visitExpr(pattern.right); // the default value IS a read
      return;
    case "RestElement":
      walkPatternReads(pattern.argument, onRead, visitExpr);
      return;
    default:
      // A destructuring-assignment target can itself be an arbitrary
      // expression (`[obj.x] = arr`) rather than a plain pattern -- treat it
      // as a normal expression.
      visitExpr(pattern);
      return;
  }
}

export function collectFreeReads(root: unknown): Set<string> {
  const reads = new Set<string>();
  const onRead = (n: AstNode) => reads.add(n.name as string);

  function visitExpr(node: unknown): void {
    if (Array.isArray(node)) {
      for (const item of node) visitExpr(item);
      return;
    }
    if (!isNode(node)) return;
    switch (node.type) {
      case "Identifier":
        onRead(node);
        return;
      case "MemberExpression":
      case "OptionalMemberExpression":
        visitExpr(node.object);
        if (node.computed === true) visitExpr(node.property);
        return;
      case "ObjectProperty": {
        if (node.computed === true) visitExpr(node.key);
        visitExpr(node.value); // shorthand `{name}` reuses the same node for key and value
        return;
      }
      case "ClassProperty":
      case "ClassPrivateProperty":
      case "PropertyDefinition":
        if (node.computed === true) visitExpr(node.key);
        if (node.value !== null && node.value !== undefined) visitExpr(node.value);
        return;
      case "ObjectMethod":
      case "ClassMethod":
      case "ClassPrivateMethod":
        if (node.computed === true) visitExpr(node.key);
        for (const p of (node.params as unknown[]) ?? []) walkPatternReads(p, onRead, visitExpr);
        visitExpr(node.body);
        return;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        for (const p of (node.params as unknown[]) ?? []) walkPatternReads(p, onRead, visitExpr);
        visitExpr(node.body);
        return;
      case "VariableDeclarator":
        walkPatternReads(node.id, onRead, visitExpr);
        if (node.init !== null && node.init !== undefined) visitExpr(node.init);
        return;
      case "CatchClause":
        if (node.param !== null && node.param !== undefined) walkPatternReads(node.param, onRead, visitExpr);
        visitExpr(node.body);
        return;
      case "LabeledStatement":
        visitExpr(node.body); // the label itself is never a read
        return;
      case "BreakStatement":
      case "ContinueStatement":
        return; // an optional label, never a read; no other children
      case "ClassDeclaration":
      case "ClassExpression":
        if (node.superClass !== null && node.superClass !== undefined) visitExpr(node.superClass);
        visitExpr(node.body); // ClassBody; the class's own `id` is a binding, not a read
        return;
      case "ImportDeclaration":
        return; // specifiers are bindings, the source is a string literal
      default:
        break;
    }
    // Generic fallback: every remaining statement/expression type (binary,
    // logical, conditional, call, new, array/template literals, assignment,
    // sequence, unary/update, throw/return/if/for/while/switch/try, ...)
    // has no binding positions of its own, so every child is a plain read
    // context.
    for (const key of Object.keys(node)) {
      if (WALK_SKIP_KEYS.has(key)) continue;
      visitExpr((node as Record<string, unknown>)[key]);
    }
  }

  visitExpr(root);
  return reads;
}
