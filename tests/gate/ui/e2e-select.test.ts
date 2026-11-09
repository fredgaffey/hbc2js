// Concurrent e2e runs must not share ports or fixture roots (ui/e2e/select.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { rmSync } from "node:fs";
// @ts-expect-error plain .mjs helper without types
import { selectE2E } from "../../../ui/e2e/select.mjs";

type Sel = { apiPort: number; previewPort: number; root: string; ownsRoot: boolean; release: () => Promise<void> };

test("two concurrent selections get distinct ports and distinct roots", async () => {
  const a: Sel = await selectE2E({});
  const b: Sel = await selectE2E({});
  try {
    const ports = new Set([a.apiPort, a.previewPort, b.apiPort, b.previewPort]);
    assert.equal(ports.size, 4);
    assert.notEqual(a.root, b.root);
    assert.ok(a.ownsRoot && b.ownsRoot);
  } finally {
    await a.release();
    await b.release();
    rmSync(a.root, { recursive: true, force: true });
    rmSync(b.root, { recursive: true, force: true });
  }
});

test("explicit overrides are honoured; a busy explicit port is refused", async () => {
  const a: Sel = await selectE2E({});
  const base = a.apiPort;
  await a.release();
  try {
    const hold = await new Promise<ReturnType<typeof createServer>>((res) => {
      const s = createServer();
      s.listen({ port: base, host: "127.0.0.1" }, () => res(s));
    });
    await assert.rejects(selectE2E({ HBC2JS_E2E_PORT_BASE: String(base) }), /busy/);
    await new Promise((r) => hold.close(r));
    const c: Sel = await selectE2E({ HBC2JS_E2E_PORT_BASE: String(base), HBC2JS_E2E_ROOT: "/x/y" });
    assert.deepEqual([c.apiPort, c.previewPort, c.root, c.ownsRoot], [base, base + 1, "/x/y", false]);
    await c.release();
  } finally {
    rmSync(a.root, { recursive: true, force: true });
  }
});
