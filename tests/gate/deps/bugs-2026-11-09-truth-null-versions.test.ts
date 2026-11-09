// bugs-2026-11-09-truth-null-versions: tools/deps-truth.mjs emitted
// `version: null` for every package under a pnpm layout
// (node_modules/.pnpm/<name>@<ver>[_peers]/node_modules/<name>/...) once the
// install tree was gone, and for workspace packages without --root.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error untyped .mjs tool
import { truthFromMap } from "../../../tools/deps-truth.mjs";

const sources = [
  "/node_modules/.pnpm/foo@1.2.3/node_modules/foo/index.js",
  "/node_modules/.pnpm/@scope+bar@4.5.6_react@19.0.0_abcdef/node_modules/@scope/bar/lib/a.js",
  "/node_modules/.pnpm/baz@2.0.0-beta.1/node_modules/baz/b.js",
  "/packages/native/src/index.tsx",
  "/packages/ghost/src/index.tsx",
  "/node_modules/plain/index.js",
];

function build(withRoot: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-nullver-"));
  try {
    const js = sources.map((_, i) => `__d(function(g,r){},${i},[]);`).join("\n") + "\n";
    writeFileSync(join(dir, "b.js"), js);
    // one segment per line: AAAA, then ACAA (source +1, rest 0) per line
    const mappings = sources.map((_, i) => (i === 0 ? "AAAA" : "ACAA")).join(";");
    writeFileSync(join(dir, "b.map"), JSON.stringify({ version: 3, sources, names: [], mappings }));
    mkdirSync(join(dir, "ws", "packages", "native"), { recursive: true });
    writeFileSync(join(dir, "ws", "packages", "native", "package.json"), JSON.stringify({ name: "@x/native", version: "7.0.1" }));
    return truthFromMap([], join(dir, "b.map"), join(dir, "b.js"), withRoot ? { root: join(dir, "ws") } : {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("truth-null-versions: pnpm path segments give versions without node_modules on disk", () => {
  const t = build(false);
  assert.equal(t.packages["foo"], "1.2.3");
  assert.equal(t.packages["@scope/bar"], "4.5.6");
  assert.equal(t.packages["baz"], "2.0.0-beta.1");
  assert.equal(t.modules["1"].version, "4.5.6");
});

test("truth-null-versions: unresolvable versions are null with a reason", () => {
  const t = build(false);
  assert.equal(t.packages["plain"], null);
  assert.match(t.versionNullReasons["plain"], /package\.json/);
  assert.equal(t.versionNullReasons["foo"], undefined);
});

test("truth-null-versions: workspace sources take the nearest package.json under --root", () => {
  const t = build(true);
  assert.equal(t.packages["@x/native"], "7.0.1");
  assert.equal(t.packages["foo"], "1.2.3");
});
