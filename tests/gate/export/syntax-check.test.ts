// Export safety net (docs/BUGS.md `for-of-noreturn-handler-label`): export
// once wrote a module file that did not parse (`break L12` with no `L12`),
// and Metro then failed the whole app. Every module file is now parsed
// before it is written; a failing render drops to the flat text, then to a
// throwing stub, with an EXPORT.json `unresolved` row and a
// `tierDowngradeReason`. The failures here are injected through the
// `syntaxCheck` test hook.
import { test } from "node:test";
import assert from "node:assert/strict";
import { exportProject } from "../../../src/export/index.ts";
import { loadModuleSyntaxCheck } from "../../../src/export/syntax-check.ts";
import { RN_TEMPLATE } from "./support.ts";

interface ManifestModule { readonly id: number; readonly path: string; readonly tier: string; readonly tierDowngradeReason: string | null }

test("export syntax check: a readable render that does not parse falls back to flat, a flat one to a stub, and both are recorded", async () => {
  let flatOnly: number | undefined;
  let stubbed: number | undefined;
  const injected = (code: string): string | null => {
    const m = /^\/\/ hbc2js export -- module (\d+) \(tier: (\w+)/.exec(code);
    if (m === null) return null;
    const id = Number(m[1]);
    const readable = m[2] === "passes" || m[2] === "jsx";
    if (readable && flatOnly === undefined) flatOnly = id;
    else if (readable && stubbed === undefined && id !== flatOnly) stubbed = id;
    if (id === flatOnly && readable) return "Undefined label 'L12' (injected)";
    if (id === stubbed && m[2] !== "stub") return "Unsyntactic break (injected)";
    return null;
  };
  const { files, manifest } = await exportProject(RN_TEMPLATE, { substitute: "none", syntaxCheck: injected });
  assert.ok(flatOnly !== undefined && stubbed !== undefined, "the injected check saw at least two readable renders");
  const mods = manifest["modules"] as readonly ManifestModule[];
  const a = mods.find((m) => m.id === flatOnly)!;
  const b = mods.find((m) => m.id === stubbed)!;
  assert.equal(a.tier, "flat");
  assert.match(a.tierDowngradeReason ?? "", /failed the export syntax check \(Undefined label 'L12' \(injected\)\)/);
  assert.equal(b.tier, "stub");
  assert.match(b.tierDowngradeReason ?? "", /Unsyntactic break \(injected\)/);
  assert.match(files.get(b.path)!, /could not be exported as valid JavaScript/);
  const rows = (manifest["unresolved"] as readonly { kind: string; detail: string }[]).filter((u) => u.kind === "syntax-check-failed");
  assert.deepEqual(rows.map((r) => Number(/^module (\d+)/.exec(r.detail)![1])).sort((x, y) => x - y), [flatOnly, stubbed].sort((x, y) => x - y));
  // What was written in their place really parses.
  const real = await loadModuleSyntaxCheck();
  assert.equal(real(files.get(a.path)!, a.path), null);
  assert.equal(real(files.get(b.path)!, b.path), null);
});

test("export syntax check: the real check rejects a dangling label and accepts JSX", async () => {
  const real = await loadModuleSyntaxCheck();
  assert.match(real("for (const x of y) { break L12; }", "m.js") ?? "", /L12|break/i);
  assert.equal(real("var a = <View style={s}>{x}</View>;", "m.js"), null);
});
