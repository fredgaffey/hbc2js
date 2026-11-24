# Torture app — a benchmark app with exact ground truth

A React Native app we write ourselves, so every module path, function name,
dependency version and return value is known exactly. It stresses the
decompiler (hard language features, huge function counts), `hbc2js export`
(module layout, app-vs-vendor segregation, free identifiers) and dependency
detection (exact pinned versions). Sibling of `tools/appgen/` (spec 09 §2,
which owns realistic *shape* fuzzing); this one owns *scale + exact semantics*.
It reuses appgen's seeded PRNG (`tools/appgen/lib/prng.mjs`) and its
no-Gradle pipeline (Metro bundle -> hermesc -> compose source maps).

Committed: generators and the hand-written app only. Everything generated
(workspace, bundles, manifests) goes to `tools/torture/out/` (gitignored).

## Layout

| Path | What |
|---|---|
| `app/src/core/*.js` | hand-written feature checks: deep closures + captured loop vars, generators (`yield*`, `throw`/`return` protocol), async/await in loops inside try/catch/finally, `Promise.all/allSettled/race`, async generators + `for await`, classes with `#private` fields/methods/static, `#x in o`, static blocks, getters/setters, `super` calls, computed keys, Proxy/Reflect, WeakMap/WeakSet, Symbols, labelled break/continue, big switch with fallthrough, optional chaining / nullish / logical assignment, tagged templates, destructuring with defaults, spread/rest, BigInt, RegExp named groups / sticky / unicode / dotAll / `matchAll`, Intl (guarded), JSON round-trips. 28 zero-argument entry points (`app/src/core/index.js` `CORE_ENTRIES`). |
| `gen-junk.mjs` | seeded generator: `--seed S --functions N` -> N functions in N/20 modules under `src/junk/gNNN/`, random bounded control flow over arrays/objects/Maps/Sets/strings/numbers, a random cross-module call DAG, each returning a uint32 checksum. |
| `app/` (rest) | the RN shell: bottom tabs + native stack (react-navigation 6), a zustand store, i18next/react-i18next (en/fr), AsyncStorage persistence, dayjs; screens run the core checks and the junk checksum and render them. `headless.js` is a second entry that prints every result as JSON (for Node and the Hermes VM). |
| `build.mjs` | one variant end to end + `manifest.json`. |
| `score.mjs` | scores an `hbc2js export` tree against a manifest. |

### Safety of generated junk

Pure in-memory computation only: no I/O, no `eval`/`Function`, no timers, no
native modules, no dynamic `import()`/`require`. Every loop has a constant
bound (`for` <= 6, `while` <= 5, `do` <= 4, `for..of` over `arr.slice(0, <=6)`),
calls never sit inside loops, and a function only calls functions of strictly
lower level (0..3), so one entry call runs at most 15 function bodies. Same
seed -> byte-identical source (gate-tested).

## Framework choice: bare RN (Expo deferred)

Bare React Native 0.73.11 (HBC 96 from its own `sdks/hermesc`), because the
appgen pipeline already proves that toolchain builds on Linux without Gradle,
and its exact-pinned dependency set is what dependency detection is scored
against. Expo (`expo export`) is a second bundler path with its own module
set; it is the natural `--framework expo` follow-up, not implemented yet.
HBC 98/99 are produced by compiling the same Metro bundle with
`tools/hermesc/v98|v99/hermesc` (`compiler: "direct-hermesc"` in the
manifest, the spec 09 §2.1 fallback provenance).

## Build

    node tools/torture/build.mjs --seed 1 --functions 1000 [--hbc 96|98|99] [--minify] [--obfuscate] [--out DIR] [--ws DIR]
    node tools/torture/build.mjs --verify-hermes tools/torture/out/<variant> [--hermes PATH]

Run heavy builds on the Linux build node: the workspace
`out/_ws` is reused, so `npm install` runs only when the pins change.
Steps: write the app + junk into the workspace -> **truth**: run
`headless.js` on the plain ESM sources in Node -> (`--obfuscate`:
`javascript-obfuscator` 4.1.1, BSD-2-Clause, over `src/core` + `src/junk`,
truth re-run and diffed into `obfuscationCheck`) -> Metro bundle of
`index.js` and of `headless.js` (`--minify` toggles Metro's terser) ->
`hermesc -O` -> compose source maps -> `manifest.json`. If a Hermes VM for
the HBC version exists (`tools/hermes-vm/v<N>/bin/hermes`, `tools/hermesc/v<N>/hermes` or
`$HBC2JS_TORTURE_HERMES`), `headless.hbc` is run in it and every result is
compared with the Node truth (`manifest.hermesVm`); otherwise copy the output
dir to a machine that has one and run `--verify-hermes`.

Output (`out/<variant>/`): `bundle.hbc`, `bundle.map` (composed),
`bundle.js` + `bundle.js.map` (Metro), `headless.hbc`, `source/` (N <= 10k),
`manifest.json`:

- `dependencies` — the exact pins; `bundledPackages` — every npm package
  that actually landed in the bundle, with installed version and module count
- `moduleIds` — Metro/HBC module id -> source path, for every module
- `appModules`, `junkModules` (path, function names, imports)
- `core[]` / `junk[]` — every entry point with its module and `expected`
  value (junk also: level, callees, entry `arg`, function-vs-arrow form)
- `coreFunctionNames` — every named function/class/method per core module
- `sizes`, `sha256`, `timings`, `hermesVm`, `obfuscationCheck`

Junk entry argument: `entryArg(name)` (FNV-1a of the export name % 1000 + 1),
so any harness can derive it from the recovered export name alone.

## Score

    node tools/torture/score.mjs <export-dir> <manifest.json> [--jobs N] [--timeout-ms T]

- **deps**: recovered (`package.json` + `EXPORT.json`) vs direct pins and vs
  every bundled package — recall, precision, false positives, exact-version
  rate, RN version.
- **modules**: app module path (exact / basename), app-vs-vendor bucket,
  vendor owner package.
- **names**: truth function names declared (`function NAME(` or the
  `// fn#N "NAME"` header) in the recovered file of the right module.
- **freeIdentifiers**: `tools/export-check/free-idents.mjs` over the tree.
- **semantic**: each core/junk module is loaded from the exported tree in a
  fresh Node child (`src/_hbc/helpers.js` + `registry.js`, then `r(id)`), every
  entry point called and compared with `manifest.expected` — independent of
  hbc2js's own oracle. Statuses: pass, wrong-value, threw, missing,
  load-failed, timeout, module-not-exported.

## Engine divergences found while writing the core

Three first-draft checks computed different values in Node and in the Hermes
VM; they were rewritten to be engine-independent, and are recorded here
because they are exactly the kind of thing a decompiler oracle must not
"fix": (1) `static [Symbol.hasInstance]` on a Babel-transformed class is not
honoured by `instanceof` in Hermes; (2) a write to a frozen object throws in
Node's strict ESM but is silently ignored in the Metro/Hermes module body
(non-strict); (3) Babel dedupes identical tagged-template literals at
different call sites, so `same\`x\` === same\`x\`` is true after Metro, false
in Node.

## Gate

`tests/gate/torture/torture-gen.test.ts` (fast, no network): seed 1 at N=50
is byte-identical across runs, junk contains only bounded pure code with a
level-ordered call DAG, every function terminates in Node with a uint32 and
the headless harness agrees with direct calls, and the module-id parser
reads Metro's `__d` layout.
