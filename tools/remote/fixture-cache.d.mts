// Ambient type declaration for fixture-cache.mjs, so a `.ts` test (with
// `allowJs` off, per tsconfig.json) can import it without a TS7016
// "implicitly has an 'any' type" error -- see tools/remote/pick.d.mts for the
// same pattern. tests/gate/tools/remote-fixture-cache.test.ts.

/**
 * Given the relative paths present in the fixture cache and a predicate
 * for whether a path already exists in the job worktree, return the
 * subset that should be symlinked in.
 */
export function planFixtureLinks(cacheRelPaths: readonly string[], existsInWorktree: (relPath: string) => boolean): string[];
