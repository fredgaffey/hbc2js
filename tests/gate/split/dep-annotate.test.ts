import { test } from "node:test";
import assert from "node:assert/strict";
import { id, lit, member, num } from "../../../src/emit/ast.ts";
import type { Expr, Stmt } from "../../../src/emit/ast.ts";
import { printProgram } from "../../../src/emit/print.ts";
import { annotateDependencyReads } from "../../../src/split/dep-annotate.ts";

// A factory-shaped statement list: `let list = deps; let a = list[0]; let
// three = 3; let b = list[three]; let dyn = list[i]; let far = list[99];`
// -- one direct-literal constant index, one copy-propagated constant index
// (the shape tag.ts's own docstring says hermesc actually produces: the
// index materialised into its own register one statement earlier), one
// truly dynamic index (a real parameter, unresolvable), and one constant
// index with no dependency data at that slot (out of range).
const PARAMS = ["g", "r", "i", "gl", "m", "e", "deps"] as const;

function fixtureBody(): readonly Stmt[] {
  return [
    { k: "init", kind: "let", name: "list", value: id("deps") },
    { k: "init", kind: "let", name: "a", value: member(id("list"), num(0), true) },
    { k: "init", kind: "let", name: "three", value: num(3) },
    { k: "init", kind: "let", name: "b", value: member(id("list"), id("three"), true) },
    { k: "init", kind: "let", name: "dyn", value: member(id("list"), id("i"), true) },
    { k: "init", kind: "let", name: "far", value: member(id("list"), num(99), true) },
    { k: "return", arg: { k: "array", elements: [id("a"), id("b"), id("dyn"), id("far")] } },
  ];
}

function findInit(body: readonly Stmt[], name: string): Extract<Stmt, { readonly k: "init" }> {
  const s = body.find((x) => x.k === "init" && x.name === name);
  assert.ok(s !== undefined, `no init statement named ${name}`);
  return s as Extract<Stmt, { readonly k: "init" }>;
}

test("annotateDependencyReads: comments a literal and a copy-propagated constant index, never a dynamic or out-of-range one", () => {
  const depIds = [111, 222, 333, 444]; // indices 0..3; index 3 (three=3) -> 444
  const { body, annotated } = annotateDependencyReads(fixtureBody(), [...PARAMS], depIds);

  // The falsifier's count half: exactly the two provably-constant sites got
  // a comment, nothing else did.
  assert.equal(annotated, 2, "expected exactly 2 resolvable constant-index sites (list[0] and list[three])");

  const aValue = findInit(body, "a").value as Expr;
  assert.equal((aValue as { comment?: string }).comment, "module 111", "list[0] must resolve to depIds[0]");

  const bValue = findInit(body, "b").value as Expr;
  assert.equal((bValue as { comment?: string }).comment, "module 444", "list[three] (three=3) must resolve to depIds[3] via copy propagation");

  // The falsifier's "never guess" half.
  const dynValue = findInit(body, "dyn").value as Expr;
  assert.equal((dynValue as { comment?: string }).comment, undefined, "list[i] (a real parameter) must never be annotated");

  const farValue = findInit(body, "far").value as Expr;
  assert.equal((farValue as { comment?: string }).comment, undefined, "list[99] has no data at that slot (depIds.length === 4) and must never be annotated");

  // The comment actually reaches the printed text, once, for each resolved
  // site, and never for the unresolved ones.
  const printed = printProgram([{ k: "func", name: "f", params: PARAMS.map((n) => ({ name: n })), body }]);
  const comments = printed.match(/\/\* module \d+(?::[^*]+)? \*\//g) ?? [];
  assert.deepEqual(comments.sort(), ["/* module 111 */", "/* module 444 */"], `printed comments: ${JSON.stringify(comments)}`);
});

test("annotateDependencyReads: prints the package name when packageOf knows it, and the bare form when it does not", () => {
  const depIds = [111, 222];
  const packageOf = (moduleId: number): string | undefined => (moduleId === 111 ? "react-native-keychain" : undefined);
  const before: readonly Stmt[] = [
    { k: "init", kind: "let", name: "a", value: member(id("deps"), num(0), true) },
    { k: "init", kind: "let", name: "b", value: member(id("deps"), num(1), true) },
  ];
  const { body, annotated } = annotateDependencyReads(before, [...PARAMS], depIds, packageOf);
  assert.equal(annotated, 2);
  const printed = printProgram([{ k: "func", name: "f", params: PARAMS.map((n) => ({ name: n })), body }]);
  assert.match(printed, /module 111: react-native-keychain/);
  assert.doesNotMatch(printed, /module 222:/, "no package name known for module 222 -- must stay bare, never a guessed name");
});

test("annotateDependencyReads: a non-computed (`.prop`) member is never mistaken for a dependencyMap index read", () => {
  const body: readonly Stmt[] = [{ k: "init", kind: "let", name: "a", value: member(id("deps"), lit('"length"'), false) }];
  const { annotated } = annotateDependencyReads(body, [...PARAMS], [111]);
  assert.equal(annotated, 0, "deps.length is a property read, not an index read, and must never be annotated");
});
