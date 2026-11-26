# Changelog

## Unreleased

### Changed
- `hbc2js deps` makes no network request by default. The npm registry search
  fallback now needs `--online`; `--confirm` (the npm confirm stage) implies
  it, and `--offline` still turns both off. Before this, a plain `deps` run
  could query `registry.npmjs.org` when a module had a name lead but no
  signature match.

### Fixed
- Corpus app Bangumi (React Native 0.66) now exports, bundles and boots
  EQUIVALENT: pre-0.70 apps get the Metro line their React Native ships with,
  `@babel/runtime` for the legacy preset, a stand-in for startup JSI globals
  such as reanimated 2's `__reanimatedModuleProxy`, and an offline bundle step
  that works before React Native 0.73.
- A `catch` with no exception binding no longer prints a dead `rX = __exc`
  copy.
- An optional chain whose base value is read again after the chain
  (`r = m[k]; ... r?.p ...; r.p`) no longer drops the base's assignment, which
  left the later read on an unassigned variable (TypeError at run time).

## 0.1.2 (2026-11-25)

Measured against real, unseen open-source apps for the first time: ten
F-Droid release builds (with their exact source commits) plus Ignite and
BlueWallet. An app counts as passing when its shipped `.hbc` exports,
`npm install`s, bundles with Metro and boots under `hbc2js equiv --boot`
with the same observable behaviour as the original bytecode (EQUIVALENT).
See `docs/e2e/OSS-BENCHMARK.md` for the table.

### Decompiler correctness (each with a minimal fixture and a gate test)
- `finally` copies that clobbered a live register (finally-dedup R-FD9).
- Per-iteration closures when the loop variable is written in the body.
- Object spread dropping a register load; destructuring defaults reading a
  later `let`; default-parameter temporaries leaking to globals.
- Dead stores removed past a `finally` or a `break` that leaves the list.
- `catch (e) { x = e }` losing its binding when the catch register is read
  after the handler.
- Private class field initialisers hoisted out of the constructor while
  reading constructor locals.
- `break` to a label dropped by the for-of pass after a no-return call
  (bytecode 98/99).
- Closures shared by several functions (orphans) now declared in every module
  file that names them; closures inlined into another scope read the
  original environment through its runtime view; self-nesting closure copies
  (zustand) become factories by an exact lexical rule.
- Generator dead `catch` blocks no longer abort the CFG (bytecode 84–96).
- Deep nests of guarded `try` blocks print as one `try` with an else-if
  chain (Hermes' optimiser ran out of memory compiling the old shape).

### Export
- Every file is parsed before it is written; one failing function is
  isolated (`EXPORT.json` `unresolved`) instead of aborting the export.
- Module loaders call factories plainly (a sloppy factory's `this` is the
  global object, as under Metro).
- `package.json`: no fake Expo packages from optional-peer probes; Expo SDK
  and React Native compatibility tables for pins; `react`/`react-native`
  resolved jointly so the tree installs; React Native CLI and Metro devDeps
  per React Native minor.
- A per-function pass work budget (`W_PASS_BUDGET`) keeps pathological
  functions from hanging an export.
- Faster: function-granularity rendering of giant modules, a linear scoped
  rewrite check, index-only rows, change-tracked environment-graph rounds.
- Bundles with no Metro registrations are reported (`no-metro-modules`).
- React Native version read from the app's own bundled `package.json`
  (exact `dependencies` pin) when the bundle carries it.
- Peer-range pins: a newer wildcard (`*`) peer segment reached by the end of
  the React Native line now wins over an older specific range (a 2019
  `react-native-safe-area-context` 0.6.2 had been pinned beside RN 0.78).

### Boot check (`equiv --boot`)
- Stub-host stand-ins for Expo modules, AsyncStorage, native constants,
  `TextEncoder`; private fields lowered for VMs that lack classes.
- `hbc2js setup-vm 96` fetches a checksum-pinned Hermes VM; clear messages
  for versions with no prebuilt VM; `hbc2js help boot`.
- Reports why a VM left no trace (signal, out-of-memory, timeout); a VM
  memory cap (`HBC2JS_BOOT_VM_MEMORY_MB`); the harness sizes its own heap.
- Works from an npm install: Metro and the babel transformer come from the
  export tree's own `node_modules` (run `npm install` there first; the
  message says so), relative paths are accepted, and the bundle form lowers
  private fields with the Babel found above the bundle.

### Tooling
- `tools/torture/`: a generated app with exact per-function checksums
  (`--hard` for decompiler-hostile shapes; 1k–100k functions).
- `tools/app-fuzz/`: a coverage-guided fuzzer with the Hermes VM as truth.
- `tools/sweep/`: whole-app static checks and module-factory differentials.
- `tools/findings.mjs`: one findings database for all of the above.

## 0.1.1

- Evidence labels (`--evidence`) on the machine contract and MCP results.
- npm package ships the skill and agent help; `setup-vm`; runtime
  dependencies fixed; progress output for `export`/`deps`.
- Export: no free identifiers from optional chains or computed keys; correct
  React Native/React/Expo versions from the bundle; 7–17× faster.
- Test infrastructure: per-test timeouts, `tools/wt-new.sh`,
  `npm run test:affected`.

## 0.1.0

First npm release.
