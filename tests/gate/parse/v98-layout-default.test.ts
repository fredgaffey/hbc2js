// v98-layout-default: a v98 file whose opcode table the probe cannot decide
// (hbc98-late vs the hbc99 tables both verify) parses as hbc98-late with a
// W_LAYOUT_ASSUMED warning; `strictLayout: true` keeps the D8 refusal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHbc, Hbc2jsError, ErrorCode } from "../../../src/index.ts";
import { listFixtures } from "../../support/fixtures.ts";
import { decompile } from "../../../src/decompile.ts";

const AMBIGUOUS = ["20-let-const-tdz", "33-class-inheritance-super", "89-derived-class-super-register-alias", "90-inlined-new"];

function v98(name: string): Uint8Array {
  const f = listFixtures({ group: "constructs" }).find((x) => x.name === name)!;
  return f.binaries.find((b) => b.version === 98 && b.variant !== "public")!.bytes();
}

test("ambiguous v98 fixtures parse as hbc98-late with W_LAYOUT_ASSUMED", () => {
  for (const name of AMBIGUOUS) {
    const m = parseHbc(v98(name));
    assert.equal(m.layout.opcodeTable, "hbc98-late", name);
    const d = m.diagnostics.find((x) => x.code === "W_LAYOUT_ASSUMED");
    assert.ok(d, `${name}: W_LAYOUT_ASSUMED expected`);
    assert.match(d!.message, /--opcode-table=hbc98-late/);
    assert.match(d!.message, /strict/i);
  }
});

test("strictLayout keeps E_LAYOUT_AMBIGUOUS", () => {
  for (const name of AMBIGUOUS) {
    assert.throws(
      () => parseHbc(v98(name), { strictLayout: true }),
      (e: unknown) => e instanceof Hbc2jsError && e.code === ErrorCode.E_LAYOUT_AMBIGUOUS,
      name,
    );
  }
});

test("decompile without any override works on ambiguous v98 fixtures", () => {
  const r = decompile(v98("33-class-inheritance-super"));
  assert.ok(r.code.length > 0);
  assert.ok(r.diagnostics.some((d) => d.code === "W_LAYOUT_ASSUMED"));
});

test("an explicit opcode table emits no W_LAYOUT_ASSUMED", () => {
  const m = parseHbc(v98("33-class-inheritance-super"), { opcodeTable: "hbc98-late" });
  assert.ok(!m.diagnostics.some((d) => d.code === "W_LAYOUT_ASSUMED"));
});
