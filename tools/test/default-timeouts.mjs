// Loaded into every test process via `node --import` (see tools/run-tests.mjs and the
// test:* package.json scripts). A synchronous child_process call without an explicit
// `timeout` gets a default one (and SIGKILL), so a wedged child (e.g. a hermesc waiting
// on stdin) fails the test in minutes instead of hanging the gate forever.
// Override: HBC2JS_SYNC_CHILD_TIMEOUT_MS (0 disables).
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const DEFAULT_MS = Number(process.env.HBC2JS_SYNC_CHILD_TIMEOUT_MS ?? 180_000);

function withDefaults(opts) {
  const o = opts !== null && typeof opts === "object" && !Array.isArray(opts) ? opts : {};
  return { ...o, timeout: o.timeout ?? DEFAULT_MS, killSignal: o.killSignal ?? "SIGKILL" };
}
function wrap(name) {
  const orig = cp[name];
  cp[name] = function (...args) {
    if (DEFAULT_MS <= 0) return orig.apply(this, args);
    // signatures: (cmd, [args], [opts]) / (cmd, [opts]); options is the last object arg.
    const last = args[args.length - 1];
    if (last !== null && typeof last === "object" && !Array.isArray(last)) args[args.length - 1] = withDefaults(last);
    else args.push(withDefaults(undefined));
    return orig.apply(this, args);
  };
}
if (!cp.__hbc2jsTimeoutsPatched) {
  for (const n of ["execFileSync", "spawnSync", "execSync"]) wrap(n);
  cp.__hbc2jsTimeoutsPatched = true;
  syncBuiltinESMExports();
}
