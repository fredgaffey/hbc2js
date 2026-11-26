// Network is opt-in (2026-11-26): `hbc2js deps` with no flags must not query
// the npm registry. `--online` enables the registry search, `--confirm` (the
// npm confirm stage, network by definition) implies it, and `--offline` still
// wins over both.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDepsArgs } from "../../../src/deps/cli-args.ts";

test("deps network opt-in: no flags is offline", () => {
  assert.equal(parseDepsArgs(["app.hbc"]).offline, true);
  assert.equal(parseDepsArgs(["app.hbc", "--json", "--out", "x"]).offline, true);
});

test("deps network opt-in: --online enables the registry search", () => {
  assert.equal(parseDepsArgs(["app.hbc", "--online"]).offline, false);
});

test("deps network opt-in: --confirm implies network", () => {
  assert.equal(parseDepsArgs(["app.hbc", "--confirm"]).offline, false);
});

test("deps network opt-in: --offline wins over --online and --confirm", () => {
  assert.equal(parseDepsArgs(["app.hbc", "--online", "--offline"]).offline, true);
  assert.equal(parseDepsArgs(["app.hbc", "--confirm", "--offline"]).offline, true);
});
