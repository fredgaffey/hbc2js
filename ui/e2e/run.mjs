#!/usr/bin/env node
// ui/e2e/run.mjs — `npm run e2e`: select an isolated port pair + fixture root
// once (select.mjs), export them to prepare-fixture and Playwright, run both,
// and remove a root we created. Concurrent runs therefore never collide.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { selectE2E } from "./select.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const uiDir = join(here, "..");
const sel = await selectE2E();
await sel.release();
const env = {
  ...process.env,
  HBC2JS_E2E_PORT_BASE: String(sel.apiPort),
  HBC2JS_E2E_PREVIEW_PORT: String(sel.previewPort),
  HBC2JS_E2E_ROOT: sel.root,
};
let status = 1;
try {
  const run = (cmd, args) => spawnSync(cmd, args, { cwd: uiDir, env, stdio: "inherit" }).status ?? 1;
  status = run("node", [join(here, "prepare-fixture.mjs")]);
  if (status === 0) status = run("npx", ["playwright", "test", "--config", "e2e/playwright.config.ts", ...process.argv.slice(2)]);
} finally {
  if (sel.ownsRoot) rmSync(sel.root, { recursive: true, force: true });
}
process.exit(status);
