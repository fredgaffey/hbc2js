// tools/pkgsig/bulk/install-plan.mjs — pure decision logic for build-one.mjs's
// npm install and hermesc invocation (BUILDONE1), split out so it is testable
// offline (build-one.mjs runs main() on import).
//
// Peer policy mirrors src/deps/confirm.ts installCandidate: strict install
// first (npm >=7 installs peer dependencies), `--legacy-peer-deps` only as a
// fallback when strict resolution fails. `--legacy-peer-deps` never installs
// peers, so Metro then cannot resolve e.g. @react-navigation/native or
// react-native-worklets.

const BASE = ["--ignore-scripts", "--no-save", "--no-audit", "--no-fund"];

/** npm argv attempts, in order. */
export function installAttempts(spec) {
  return [
    ["install", spec, ...BASE],
    ["install", spec, ...BASE, "--legacy-peer-deps"],
  ];
}

/** execFileSync options for stderr-piped children: default maxBuffer (1 MiB)
 *  gives ENOBUFS on chatty hermesc/metro output (axios). */
export const MAX_BUFFER = 1 << 30;
export function pipedOpts(extra = {}) {
  return { stdio: ["ignore", "ignore", "pipe"], maxBuffer: MAX_BUFFER, ...extra };
}

/** Run attempts with `exec(cmd, argv)`; fall back on failure. Returns the
 *  index of the attempt that succeeded; throws the LAST error if all fail. */
export function runInstall(spec, exec) {
  const attempts = installAttempts(spec);
  let last;
  for (let i = 0; i < attempts.length; i++) {
    try {
      exec("npm", attempts[i]);
      return i;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}
