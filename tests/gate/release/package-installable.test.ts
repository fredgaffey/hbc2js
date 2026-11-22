// The package must be installable by others (REA's hbc2js provider, spec 34):
// publishable to npm, and buildable when installed straight from git, where
// the gitignored dist/ does not exist until `prepare` builds it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";

const pkg = JSON.parse(readFileSync(join(repoRoot(), "package.json"), "utf8")) as {
  private?: boolean;
  scripts?: Record<string, string>;
  repository?: { type?: string; url?: string };
  files?: string[];
  bin?: Record<string, string>;
  license?: string;
};

test("release: package.json is publishable (not private, MIT, repository set)", () => {
  assert.notEqual(pkg.private, true, "private: true makes npm refuse to publish");
  assert.equal(pkg.license, "MIT");
  assert.match(pkg.repository?.url ?? "", /github\.com\/fredgaffey\/hbc2js/);
});

test("release: a git install builds the CLI (prepare runs the build; dist ships)", () => {
  assert.match(pkg.scripts?.prepare ?? "", /\bnpm run build\b/);
  assert.ok(pkg.files?.includes("dist"), "files must ship dist");
  assert.equal(pkg.bin?.hbc2js, "./dist/cli.js");
});
