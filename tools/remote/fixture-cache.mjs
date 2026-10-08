// tools/remote/fixture-cache.mjs — pure helper for tools/remote/server.mjs's
// "fixture cache" step (docs/REMOTE-CI.md "Fixture cache"). A fresh job
// worktree from `git worktree add` never has a fixture's *gitignored*
// files (tests/fixtures/bundles/<name>/index.android.bundle, *.hbc, *.map,
// deps-truth.json — each fetched once by hand via that fixture's own
// fetch.sh, per the real-bundle policy, never committed). Without them,
// every test that is parameterised over "whichever fixtures happen to
// exist on this box" silently iterates fewer times: no skip, just a
// smaller passing count (see docs/REMOTE-CI.md "Is a the remote build node gate equivalent to
// a Mac gate?"). tools/remote/seed-fixtures.sh populates a compute node's
// fixture cache once (by hand, from a checkout that already ran fetch.sh);
// this module then makes every job worktree reuse that cache via
// symlinks, the same pattern server.mjs already uses for tools/hermesc
// and the node_modules cache.

/**
 * Pure planning function: given the relative paths present in the fixture
 * cache (e.g. "tests/fixtures/bundles/react-navigation-example-0.85.3/index.android.bundle",
 * always forward-slash, relative to the repo root) and a predicate for
 * whether a path already exists in the job worktree, return the subset
 * that should be symlinked in. Anything the worktree already has (a
 * tracked file such as BUILD.md sharing the fixture's directory, or a
 * previous partial run) is left alone — this never overwrites worktree
 * content, only fills gaps.
 *
 * @param {string[]} cacheRelPaths
 * @param {(relPath: string) => boolean} existsInWorktree
 * @returns {string[]} relative paths to link, same order as cacheRelPaths
 */
export function planFixtureLinks(cacheRelPaths, existsInWorktree) {
  return cacheRelPaths.filter((p) => !existsInWorktree(p));
}
