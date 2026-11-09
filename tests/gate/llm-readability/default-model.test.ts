// The default readability naming model is Sonnet (docs/READABILITY.md,
// 2026-11-09: sonnet measured more accurate and cheaper per named binding than
// haiku). Pure config resolution -- no model call.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CLAUDE_CLI_MODEL, resolveClaudeCliConfig, resolveHaikuConfig } from "../../../src/readability/types.ts";

test("default-model: the claude-cli default resolves to sonnet", () => {
  assert.equal(DEFAULT_CLAUDE_CLI_MODEL, "sonnet");
  assert.equal(resolveClaudeCliConfig({}).model, "sonnet");
});

test("default-model: the HTTP backend default is a sonnet id", () => {
  assert.match(resolveHaikuConfig({}).model, /sonnet/);
});

test("default-model: env and explicit override still win (haiku stays selectable)", () => {
  assert.equal(resolveClaudeCliConfig({ HBC2JS_LLM_MODEL: "haiku" }).model, "haiku");
  assert.equal(resolveClaudeCliConfig({ HBC2JS_LLM_MODEL: "haiku" }, { model: "opus" }).model, "opus");
});
