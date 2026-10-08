// tools/remote/install-check.mjs — pure "did the install step actually work"
// check for tools/remote/server.mjs's job runner (docs/REMOTE-CI.md "What a job
// does" step 4). Split out (like tools/remote/pick.mjs) so it is unit-testable
// without spawning npm or touching a real filesystem.
//
// Why this exists: on 2026-09-28 the deployed server.mjs on the remote build node predated
// the commit that added the `ui/` install loop (d8c595e4). Root install
// worked, `ui/` install silently never ran (the deployed code had no such
// loop at all), and the job proceeded straight to `npm run typecheck`,
// which failed ~200 lines later with a confusing "Cannot find module
// '@dagrejs/dagre'" instead of a clear "install step didn't produce
// ui/node_modules" error at the point of the actual problem. This check
// makes that failure loud and immediate regardless of *why* node_modules
// ended up missing (stale deploy, cache corruption, a future bug) — it
// only looks at the end state (lockfile present => node_modules must be
// present too), not at how the install ran.

/**
 * @typedef {{ label: string, hasLock: boolean, hasNodeModules: boolean }} InstallResult
 */

/**
 * @param {InstallResult[]} installs
 * @returns {string[]} labels of installs that had a lockfile but ended up
 *   with no node_modules — i.e. the install step silently produced nothing.
 */
export function findBrokenInstalls(installs) {
  return installs.filter((i) => i.hasLock && !i.hasNodeModules).map((i) => i.label);
}

/**
 * @param {string[]} broken - output of findBrokenInstalls
 * @returns {string|null} an actionable error message, or null if nothing's broken
 */
export function installCheckError(broken) {
  if (broken.length === 0) return null;
  return (
    `[remote-ci] install check failed: no node_modules for ${broken.join(", ")} ` +
    `after npm ci (a lockfile is present but node_modules is missing) — ` +
    `refusing to run the job's command against a missing dependency tree. ` +
    `If server.mjs was recently edited, redeploy it (tools/remote/install.sh <host>); ` +
    `otherwise check ~/hbc2js-ci/nm-cache on the compute node.`
  );
}
