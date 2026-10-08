// docs/REMOTE-CI.md "Fixture cache" — tools/remote/fixture-cache.mjs's pure
// planning function, exercised with fake path lists so this is
// unit-testable without a real filesystem or a compute node.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planFixtureLinks } from "../../../tools/remote/fixture-cache.mjs";

test("planFixtureLinks: links every cached path the worktree lacks", () => {
  const cache = [
    "tests/fixtures/bundles/react-navigation-example-0.85.3/index.android.bundle",
    "tests/fixtures/bundles/react-navigation-example-0.85.3/react-navigation-example.map",
  ];
  const result = planFixtureLinks(cache, () => false);
  assert.deepEqual(result, cache);
});

test("planFixtureLinks: never proposes a path the worktree already has", () => {
  const cache = [
    "tests/fixtures/bundles/react-navigation-example-0.85.3/BUILD.md",
    "tests/fixtures/bundles/react-navigation-example-0.85.3/index.android.bundle",
  ];
  // BUILD.md is tracked in git, so a fresh worktree already has it -- only
  // the gitignored index.android.bundle should be proposed.
  const existing = new Set(["tests/fixtures/bundles/react-navigation-example-0.85.3/BUILD.md"]);
  const result = planFixtureLinks(cache, (p) => existing.has(p));
  assert.deepEqual(result, ["tests/fixtures/bundles/react-navigation-example-0.85.3/index.android.bundle"]);
});

test("planFixtureLinks: empty cache links nothing", () => {
  assert.deepEqual(planFixtureLinks([], () => false), []);
});
