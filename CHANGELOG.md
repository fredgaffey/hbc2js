# Changelog

## 0.1.2 (unreleased)

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

### Boot check (`equiv --boot`)
- Stub-host stand-ins for Expo modules, AsyncStorage, native constants,
  `TextEncoder`; private fields lowered for VMs that lack classes.
- `hbc2js setup-vm 96` fetches a checksum-pinned Hermes VM; clear messages
  for versions with no prebuilt VM; `hbc2js help boot`.
- Reports why a VM left no trace (signal, out-of-memory, timeout); a VM
  memory cap (`HBC2JS_BOOT_VM_MEMORY_MB`); the harness sizes its own heap.

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
