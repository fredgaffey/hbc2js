// Preload for the spec-34 no-side-effects test: records every child_process
// call into the file named by HBC2JS_SPY_LOG (kept outside the sandboxed TMPDIR).
import { createRequire } from "node:module";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const cp = createRequire(import.meta.url)("node:child_process");
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  cp[name] = (...args) => {
    appendFileSync(process.env.HBC2JS_SPY_LOG, `${name} ${JSON.stringify(args[0])}\n`);
    throw new Error(`child_process.${name} is forbidden in machine-contract mode`);
  };
}
syncBuiltinESMExports();
