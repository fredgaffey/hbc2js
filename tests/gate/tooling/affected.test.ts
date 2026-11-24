// tools/test/affected.mjs -- the changed-file -> test mapper behind `npm run test:affected`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "../../support/paths.ts";

const mod = (await import(pathToFileURL(join(repoRoot(), "tools", "test", "affected.mjs")).href)) as {
  computeAffected: (changed: string[], files: Map<string, string | null>, opts?: { fast?: boolean }) => { full: string | null; tests: string[] };
};

const tree = (): Map<string, string | null> => new Map<string, string | null>([
  ["src/a.ts", `export const a = 1;`],
  ["src/b.ts", `import { a } from "./a.ts"; export const b = a;`],
  ["src/c.ts", `export const c = 3;`],
  ["src/lonely.ts", `export const l = 0;`],
  ["src/cli.ts", `import { b } from "./b.ts";`],
  ["tests/gate/x/b.test.ts", `import { b } from "../../../src/b.ts";`],
  ["tests/gate/x/c.test.ts", `import { c } from "../../../src/c.ts";`],
  ["tests/gate/x/spawn.test.ts", `const cli = "src/cli.ts"; // spawns the CLI`],
  ["tests/gate/x/lonely-thing.test.ts", `// name match only`],
  ["tests/gate/docs/d.test.ts", `readFileSync("docs/NOTES.md")`],
  ["tests/support/s.ts", `export {};`],
  ["docs/NOTES.md", null],
  ["README.md", null],
  ["package.json", null],
]);

test("a leaf source change maps to its transitive importers, not unrelated tests", () => {
  const r = mod.computeAffected(["src/a.ts"], tree());
  assert.equal(r.full, null);
  assert.deepEqual(r.tests, ["tests/gate/x/b.test.ts", "tests/gate/x/spawn.test.ts"]);
});
test("--fast drops path-mention (CLI spawn) edges into src", () => {
  assert.deepEqual(mod.computeAffected(["src/a.ts"], tree(), { fast: true }).tests, ["tests/gate/x/b.test.ts"]);
});
test("a changed test maps to itself; name match picks up a sibling test", () => {
  assert.deepEqual(mod.computeAffected(["tests/gate/x/c.test.ts"], tree()).tests, ["tests/gate/x/c.test.ts"]);
  assert.deepEqual(mod.computeAffected(["src/lonely.ts"], tree()).tests, ["tests/gate/x/lonely-thing.test.ts"]);
});
test("docs mapped via path mention", () => {
  assert.deepEqual(mod.computeAffected(["docs/NOTES.md"], tree()).tests, ["tests/gate/docs/d.test.ts"]);
});
test("unmappable changes fall back to the full gate", () => {
  for (const c of ["package.json", "tools/run-tests.mjs", "tests/support/s.ts", "tools/test/affected.mjs", "tsconfig.json", "weird.bin"]) {
    assert.notEqual(mod.computeAffected([c], tree()).full, null, c);
  }
});
test("a src file nobody depends on cannot be mapped -> full gate", () => {
  const t = tree(); t.set("src/orphan.ts", `export {};`);
  assert.notEqual(mod.computeAffected(["src/orphan.ts"], t).full, null);
});
test("README alone needs no tests", () => {
  assert.deepEqual(mod.computeAffected(["README.md"], tree()), { full: null, tests: [] });
});
