# App fuzzer — decompiler-hostile apps + a static bug-finding loop

## Problem, choice, rejected alternative

**Problem.** `tools/appgen/` fuzzes realistic app *shape* (routers, dependency
loading) and `tools/torture/` gives exact truth at scale, but its junk
generator only emits simple bounded arithmetic, so neither one looks hard for
the code shapes that actually break a decompiler.

**Choice.** A shape generator (`gen-shapes.mjs`) weighted toward
decompiler-hostile code. It plugs into the torture pipeline as a drop-in
`generate` for `tools/torture/build.mjs`, using the same file contract as
`gen-junk.mjs`. The oracle is torture's: an exact per-function uint32
checksum, computed in Node on the original ESM and compared with the same
function loaded from the `hbc2js export` tree (`score.mjs --child`). On top of
that there are cheap static checks on every export and a loop that minimises
failures, clusters them, writes them to the shared findings DB and feeds
coverage back into the template weights.

**Rejected.** We dropped a UI-heavy generator with a react-test-renderer
oracle (render trees from source vs export) because it is slow, needs pinned
renderer/mocks, and mostly exercises JSX/hook shapes that compile to ordinary
calls. Real-app UI is still covered by the `ui` profile, which exports the
full torture RN app (screens, navigation, store) around the generated code.

## Generator (`gen-shapes.mjs`)

Each function is a list of parts `{t: template, k: key}`. Every part draws
from its own PRNG stream, and its variable suffix comes from its key, so
dropping a part leaves the others byte-identical. Minimisation relies on
this. The templates are:

- `cfg` / `cfgDeep`: random structured control flow with a context stack.
  It produces if/else, for / while / do-while (counter first, so `continue`
  terminates), try/catch/finally in every combination (optional catch
  binding, jumps out of finally), switch with fallthrough and string cases,
  labelled loops and labelled blocks, `break`/`continue` to any legal label,
  `return` from anywhere, throws only where a catch encloses them, no-return
  `fail()` calls, logical assignment, nested ternaries, comma expressions and
  closures capturing state.
- Fixed shapes, each with seeded constants: `tryLoop`, `finallyReturn`,
  `labelled`, `generator` (yield in try/finally, `yield*`, `.return()`,
  `.throw()`), `asyncPrefix` (the sync prefix of an async function), `closures`
  (let/var loop capture), `classes` (#private fields/methods, static #, static
  block, `#x in o`, get/set, super), `optional`, `destructure` (param defaults
  referencing earlier params, nested rest), `spread`, `exceptions` (rethrow,
  finally over throw), `noReturn` (always-throw helpers, `for(;;)` with
  return), `numbers` (-0, NaN, 2^53, int32 edges, toString(36), toFixed),
  `strings` (surrogates, named groups, `$&`/`$$` replacement), `foldable`
  (constant-foldable expressions, dead branches), `manyLocals` (30-170 live
  locals, register pressure), `deepIf`, `getset`, `switchScopes`
  (block-scoped lets in cases captured by closures), `recursion`,
  `argumentsObj`, `bigint`, `iterators` (custom iterator `return()` on break,
  Map/WeakMap).

Safety and engine neutrality are listed in the header: the code is pure,
bounded, and avoids every Node/Hermes or strict/sloppy divergence we know of.

## Loop (`loop.mjs`)

    node tools/app-fuzz/loop.mjs --seeds 1..30 --profile hard|mixed|ui [--root /tmp/hbc2js/app-fuzz]
    node tools/app-fuzz/loop.mjs --summary          # per-seed table + ranked clusters
    node tools/app-fuzz/loop.mjs --verify-repros    # Hermes VM triage of kept repros
    node tools/app-fuzz/loop.mjs --reduce <repro-dir> [--budget 60]   # statement-level reduction -> reduced.js
    node tools/app-fuzz/rebuild-repro.mjs <repro-dir> <out>            # rebuild a repro's minimal app

The loop processes one seed at a time, so there is only ever one export.

1. **Config.** The seed picks the HBC version (96 project hermesc, 98/99
   direct hermesc) and whether to minify. `mixed` also obfuscates 1 in 5
   seeds. `hard` and `mixed` bundle only the headless entry (core + generated
   code, no RN), which takes about 25 s per seed. `ui` bundles the full
   torture RN app.
2. **Build.** `tools/torture/build.mjs` gives the Node truth, Metro, hermesc
   and `manifest.json`.
3. **Export.** `node src/cli.ts export bundle.hbc`. A crash is a finding.
4. **Checks.** These run on every export:
   - every exported `.js` parses;
   - free identifiers, via `tools/export-check/free-idents.mjs`;
   - `could not decompile ... -- E_*` stubs (W_UNBOUND_ISOLATED);
   - per-module tier and downgrade reason;
   - warning-code histogram;
   - the checksum oracle for every generated function and the 28 torture
     core entries.
5. **Minimise.** For each new cluster: halve the module's function set,
   then drop parts one at a time while the same failure kind persists. The
   cap is 14 rebuilds. The minimal case is kept under `repros/<cluster>-s<seed>/`
   (`source.js`, `exported.js`, `headless.hbc`, `repro.json`).
6. **Record.** Each finding is added through `node /tmp/hbc2js/findings.mjs add
   --source app-fuzz`. The cluster key is `app-fuzz:<kind>:<sorted shapes of
   the minimal function>`. The per-seed row is appended to `seeds.jsonl`.
7. **Guide.** `coverage.json` counts per-module features: tier, downgrade
   reason, warning codes, `__hbc_*` runtime helpers used, label /
   `while(true)` / unreachable density buckets, output bloat, and failures.
   It also records which templates were present. The next seed's weights
   favour templates that co-occur with rare features (failures count 3x),
   and the weights are recorded in each row.

**Truth is the Hermes VM.** When `tools/hermes-vm/v<N>/bin/hermes` exists
(built by `tools/build-hermes-vm.sh <N>`; on Linux, build it inside the
loop's code copy), the decompiled output is compared with what the bytecode
computes in the VM. When Node and Hermes disagree, the case is recorded as
`hermes-vs-node` (low severity, never a decompiler bug). The first one found
was `finallyReturn` on HBC 96 with Metro minify. Without a VM the row is
marked `node-unverified`, and `--verify-repros` re-checks the kept repros on
a machine that has one.

## Gate

`tests/gate/app-fuzz/app-fuzz-gen.test.ts` (< 1 s) checks:

- determinism;
- every template is reachable;
- parts are independent;
- two tiny seeds run in Node with every function returning a uint32;
- the guided weights move toward rare features.
