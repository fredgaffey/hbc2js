// Ambient type declaration for install-check.mjs, so a `.ts` test (with
// `allowJs` off, per tsconfig.json) can import it without a TS7016
// "implicitly has an 'any' type" error -- see tools/remote/pick.d.mts for the
// same pattern. tests/gate/tools/remote-install-check.test.ts.
export interface InstallResult {
  readonly label: string;
  readonly hasLock: boolean;
  readonly hasNodeModules: boolean;
}

/** Labels of installs that had a lockfile but ended up with no node_modules. */
export function findBrokenInstalls(installs: readonly InstallResult[]): string[];

/** An actionable error message, or null if nothing's broken. */
export function installCheckError(broken: readonly string[]): string | null;
