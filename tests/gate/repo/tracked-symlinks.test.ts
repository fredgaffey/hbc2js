// Worktree convenience symlinks (tools/hermesc, ui/node_modules) must never be
// tracked: their targets are absolute paths, and checking them out deletes the
// real, git-ignored directories they replace, because git treats ignored files
// as expendable. No tracked file may be a symlink to an absolute path, and the
// dependency/toolchain directories are never tracked in any form.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { repoRoot } from "../../support/paths.ts";

function lsFiles(): { mode: string; path: string; object: string }[] {
  const out = execFileSync("git", ["ls-files", "-s"], { cwd: repoRoot(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\n").filter(Boolean).map((l) => {
    const [meta, path] = l.split("\t");
    const [mode, object] = meta!.split(" ");
    return { mode: mode!, object: object!, path: path! };
  });
}

test("repo: no tracked symlink points at an absolute path", () => {
  const bad = lsFiles()
    .filter((f) => f.mode === "120000")
    .map((f) => ({ path: f.path, target: execFileSync("git", ["cat-file", "blob", f.object], { cwd: repoRoot(), encoding: "utf8" }) }))
    .filter((f) => f.target.startsWith("/"))
    .map((f) => `${f.path} -> ${f.target}`);
  assert.deepEqual(bad, []);
});

test("repo: node_modules and the local Hermes toolchain dirs are never tracked, as a dir or a symlink", () => {
  const bad = lsFiles()
    .map((f) => f.path)
    .filter((p) => /(^|\/)node_modules(\/|$)/.test(p) || /^tools\/(hermesc|hermes-vm)(\/|$)/.test(p));
  assert.deepEqual(bad, []);
});
