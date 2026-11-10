# Dependency detection triage, 2026-11-10

Every remaining false positive and every missed true package across the five
truth apps (Expensify, react-navigation, bluesky, rainbow, MetaMask), with a
cause class for each, the open branch that touches it, and a ranked plan.
Read-only analysis of existing outputs on deb. No matcher run or DB build was
started for it.

## Inputs and method

- **Base** = `integrate-1110a`, measured as `deps-rnav-recall/out/after-<app>.json`
  (`meas2.mjs`, full v4 farm `deps-rm/f-v4`: 2,185 packages, 71,226 files).
- **Transub stack** = `deps-db-growth` + `deps-metamask-fp` +
  `deps-transitive-subtract`, measured as `deps-transub-meas/out/after-<app>.json`.
- Per-candidate tier and demotion: `deps-mm-fp-dumps/<app>.dump.json` (`pk`
  holds every high or demoted candidate, with hit hashes). FP hit ownership is
  hit hash -> `occ` -> function -> `moduleOf` -> source-map package from the
  truth file.
- Tiny-bar candidates: `deps-rnav-recall/out/tiny-<app>.txt`. Full per-package
  causes exist only for react-navigation (`out/cls-nav.txt`, from `classify.mjs`,
  which runs the matcher, so it was not re-run for the other four).
- Scripts: `~/_hbc2js/deps-rnav-recall/tri1110{,b,c,d}.py` on deb; the joined
  data is `tri1110.json` / `tri1110-rows.json` beside them.

Cause classes for a missed true package, applied in order:

| class | meaning |
|---|---|
| not-in-DB | no file for the package in `deps-rm/f-v4` at any version. `not-in-DB(no-code-modules)`: the app holds only assets (fonts) of it |
| no-HBC-build | in the farm, but no version built at the app's HBC version (Expensify, react-navigation, bluesky are HBC 98; rainbow and MetaMask HBC 96) |
| version-missing | built at the app's HBC version, but not the truth version |
| tiny | in the DB at the truth version, never high: fewer than 3 app code modules, or listed as a tiny-bar TP in `tiny-<app>.txt`, or `c:tiny-bar` in `cls-nav.txt` |
| below-bar(fn-only / one-module) | react-navigation only (`cls-nav.txt`): scored, but exact hits only at function level, or one module |
| unknown | in the DB at the truth version with 3 or more app code modules, never high or demoted. Not split further without a matcher run: below-bar or never proposed |
| demoted-by-`<rule>` | high, then demoted (`pk[].dem`) |
| ambiguity | the ljharb hashes over `AMBIGUOUS_OWNER_THRESHOLD` (DEPS.md, corpus-ambiguity-cutoff) |
| copies | true code claimed as a copy by another loaded signature (DEPS.md, corpus-db-growth open item) |

A false positive is classed by where its hit functions sit in the source map:
`copies (hits in X)` when another package's modules hold the hits (inlined
dependency, twin, or fork), `copies (fork/rename of X)` when the truth holds a
fork or renamed package instead, `truth-noise?` when the hits are mostly in
app-owned modules (an app-vendored copy the truth cannot label). None of the
FPs is a wrong truth label in the strict sense (deps-metamask-fp checked all
MetaMask ones).

## Totals by cause class

Missed true packages at base (plus TPs the transub stack loses):

| cause | Expensify | react-navigation | bluesky | rainbow | MetaMask | all |
|---|---|---|---|---|---|---|
| truth / TP at base | 288 / 100 | 76 / 22 | 198 / 46 | 518 / 109 | 749 / 159 | 1,829 / 436 |
| not-in-DB | 143 | 29 | 121 | 320 | 497 | 1,110 |
| version-missing | 21 | 2 | 0 | 45 | 38 | 106 |
| no-HBC-build | 2 | 3 | 2 | 6 | 6 | 19 |
| tiny | 22 | 11 | 15 | 37 | 42 | 127 |
| below-bar / not-candidate / version-drift (nav) | | 9 | | | | 9 |
| unknown | 0 | 0 | 14 | 0 | 5 | 19 |
| demoted-by-bundled-dist | 0 | 0 | 0 | 1 | 0 | 1 |
| ambiguity | 0 | 0 | 0 | 0 | 2 | 2 |
| missed total | 188 | 54 | 152 | 409 | 590 | 1,393 |
| TP lost by transub stack | 0 | 1 | 3 | 1 | 4 | 9 |
| missed TP recovered by transub stack | 2 | 0 | 0 | 0 | 6 | 8 |

False positives (base union transub stack):

| cause | Expensify | react-navigation | bluesky | rainbow | MetaMask |
|---|---|---|---|---|---|
| copies (inlined dependency, twin, fork) | 6 | 0 | 1 | 5 | 19 |
| truth-noise? (app-owned hits) | 1 | 0 | 0 | 2 | 1 |
| removed by transub stack | 4 | 0 | 0 | 1 | 8 |
| still FP after transub stack | 3 | 0 | 1 | 6 | 12 |

**The DB is the recall ceiling.** 1,235 of 1,393 misses (89%) are the DB
lacking the package, the version, or the HBC build. Of the rest, 127 are
tiny. Scoring and demotion account for 31.

## Ranked levers (expected TP gain at no FP cost)

1. **Populate the 564 not-in-DB misses with 3 or more app code modules**
   (459 distinct packages in the wishlist). At base, 436 of the 594 truth
   packages that are in the DB at the right version and HBC are confirmed
   (73%), so expect about 410 TPs, about 22 recall points overall. The FP cost
   is not free: `deps-db-growth` measured new FPs from DB growth (copies
   claimed as own, ambiguity cutoff growing with candidates). Land
   `deps-db-growth` and `deps-ambiguity-cutoff` first, and gate each overlay
   on five-app TP/FP. Top cross-app gaps: `semver` (all 5 apps, 136 modules),
   `@babel/runtime` (5, 77), `@sentry/core` (4, 368), `@sentry/browser`,
   `react-native-keyboard-controller`, `@react-navigation/elements`,
   `multiformats`, `expo`.
2. **Exact truth versions for the 106 version-missing misses** (40 with 3 or
   more code modules; mostly rainbow and MetaMask at HBC 96). Same rules and
   FP risk as an existing package, since the package is already a candidate.
   Expect 40 to 80 TPs.
3. **Admit tiny packages with a unique-owner, module-exact hit and no
   ambiguous hits** (`u>0 && mh>0 && amb==0` in `tiny-<app>.txt`). 18 TP
   packages, 0 FP (counting ambiguous hits, 18 TP to 1 FP: `d3-fetch` on
   MetaMask): mime-db, react-freeze, react-native-config, debounce, invariant
   (x3 apps), email-validator, lodash.chunk, nullthrows (x2), form-data,
   base64-js (x2), klona, react-native-launch-arguments, ulid,
   @react-native/normalize-colors. It also unlocks the 539 small not-in-DB
   packages that lever 1 adds, which today would all stop at the tiny bar.
4. **Build the 19 no-HBC-build misses at the app's HBC version**: `expo` and
   `nullthrows` at HBC 98 (3 apps each), `@react-native-vector-icons/common`
   98; `@react-navigation/core`, `react-native-mmkv`, `supports-color` at HBC
   96 (2 apps each), `@react-navigation/material-top-tabs`, `bip39`,
   `recyclerlistview`, `chalk`, `eciesjs`, `react-native-quick-crypto` at
   96. 19 TPs at most.
5. **Keep the 9 TPs the transub stack loses** before it lands (react-navigation
   and bluesky `@react-native/normalize-colors`, bluesky
   `react-native-gesture-handler` and `react-native-svg`, `base-64` on rainbow
   and MetaMask, MetaMask `klona`, `readable-web-to-node-stream`, `valid-url`).
   `deps-ambiguity-cutoff` covers react-native-svg (f328d4d). The stack
   already gains 8 TPs (fork relabels, `source-map`,
   `whatwg-url-without-unicode`) and removes 13 FPs. Net with this fix:
   +8 TP, -13 FP.

Not ranked: the 19 `unknown` and 9 react-navigation below-bar misses are
mostly the same shared packages (`@tanstack/query-core`,
`@tanstack/react-query`, `expo-modules-core`,
`@react-native/virtualized-lists`, `@react-native-async-storage/async-storage`,
`date-fns`, `libphonenumber-js`, `abitype`, `prop-types`). `cls-nav.txt`
shows these are `fn-only` (exact hits in shared functions, no module hit),
which suggests version drift within the DB's versions. That needs a
matcher-run probe, so it is the next item after the DB levers. The remaining
FPs are copies. 12 survive the transub stack, and
`deps-metamask-fp` found no sound rule for the largest class (pathless
signatures whose hits are their dependencies' code). Path-bearing (v4-paths)
rebuilds of those packages are the likely fix, at no TP cost.

## DB wishlist

`docs/deps-db-wishlist-1110.json` uses the `tools/pkgsig/bulk/candidates.json`
shape (`schema`, `packages[]` of `{name, versions[], reasons[]}`), so
`run.sh` can take it as `PACKAGES_JSON`. Its extra fields are informational:
`hbcVersions` (the app HBC versions needed), `appCodeModules`, `listedBefore`
(already in packages.json/candidates.json, so a previous build did not land
in the farm) and `priorBuildFailures` (lines in `db-v4-paths*.failed.txt`).
It has 790 packages and 903 version selections, deduplicated across apps:
the not-in-DB, version-missing and no-HBC-build misses that have app code
modules. 459 have 3 or more code modules. 84 more, mostly react-navigation,
whose truth file has no versions, are under `unresolvedVersion`; resolve them
from the app's lockfile before building. 172 were listed in an earlier round
and 58 have recorded build failures, so a plain rerun will not land those.

## Per-package rows

Evidence paths are relative to `~/_hbc2js/` on deb
(`out/` = `deps-rnav-recall/out/`). For FP rows the version column is the
matched version.

| app | package | version | verdict | cause class | app code modules | evidence | addressed by |
|---|---|---|---|---|---|---|---|
| Expensify | `@babel/runtime` | 7.28.6 | missed-TP | not-in-DB | 37 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@expensify/react-native-live-markdown` | 0.1.336 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@expensify/react-native-wallet` | 0.1.22 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@expo/log-box` | 57.0.1 | missed-TP | not-in-DB | 5 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@expo/metro` | 56.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@formatjs/ecma402-abstract` | 2.0.0 | missed-TP | not-in-DB | 45 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@formatjs/intl-enumerator` | 1.4.7 | missed-TP | not-in-DB | 15 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@formatjs/intl-getcanonicallocales` | 2.3.0 | missed-TP | not-in-DB | 7 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@formatjs/intl-listformat` | 7.5.7 | missed-TP | not-in-DB | 15 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@formatjs/intl-locale` | 4.0.0 | missed-TP | not-in-DB | 10 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@formatjs/intl-localematcher` | 0.5.4 | missed-TP | not-in-DB | 11 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@formatjs/intl-numberformat` | 8.10.3 | missed-TP | not-in-DB | 11 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@formatjs/intl-pluralrules` | 5.2.14 | missed-TP | not-in-DB | 19 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@fullstory/react-native` | 1.9.0 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@gorhom/portal` | 1.0.14 | missed-TP | not-in-DB | 9 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@jsamr/counter-style` | 2.0.2 | missed-TP | not-in-DB | 17 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@jsamr/react-native-li` | 2.3.1 | missed-TP | not-in-DB | 5 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@lottiefiles/dotlottie-react` | 0.13.5 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@native-html/css-processor` | 1.11.0 | missed-TP | not-in-DB | 36 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@native-html/transient-render-engine` | 11.2.2 | missed-TP | not-in-DB | 24 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@onfido/react-native-sdk` | 15.1.0 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@pusher/pusher-websocket-react-native` | 1.3.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@react-native-documents/picker` | 10.1.3 | missed-TP | not-in-DB | 10 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@react-native-firebase/analytics` | 22.2.1 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@react-native/assets-registry` | 0.86.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@react-native/normalize-color` | 2.1.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@react-native/normalize-colors` | 0.86.0 | missed-TP | version-missing | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@react-navigation/bottom-tabs` | 7.15.5 | missed-TP | not-in-DB | 15 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@react-navigation/elements` | 2.9.14 | missed-TP | not-in-DB | 31 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@react-navigation/native-stack` | 7.14.5 | missed-TP | not-in-DB | 10 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@rnmapbox/maps` | 10.3.2 | missed-TP | not-in-DB | 127 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@sbaiahmed1/react-native-biometrics` | 0.15.0 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@sentry-internal/browser-utils` | 10.47.0 | missed-TP | not-in-DB | 37 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@sentry-internal/feedback` | 10.47.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@sentry-internal/replay` | 10.47.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@sentry-internal/replay-canvas` | 10.47.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@sentry/browser` | 10.47.0 | missed-TP | not-in-DB | 45 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@sentry/core` | 10.47.0 | missed-TP | not-in-DB | 368 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@sentry/react` | 10.47.0 | missed-TP | not-in-DB | 18 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@turf/along` | 6.5.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@turf/bbox` | 6.5.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@turf/bearing` | 6.5.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@turf/destination` | 6.5.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@turf/distance` | 6.5.0 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@turf/helpers` | 6.5.0 | missed-TP | not-in-DB | 11 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@turf/invariant` | 6.5.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@turf/length` | 6.5.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@turf/line-intersect` | 6.5.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@turf/line-segment` | 6.5.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@turf/meta` | 6.5.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@turf/nearest-point-on-line` | 6.5.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@ua/react-native-airship` | 26.5.0 | missed-TP | not-in-DB | 27 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@ungap/structured-clone` | 1.3.0 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `@welldone-software/why-did-you-render` | 7.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `anser` | 1.4.10 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `ansi-regex` | 5.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `ansi-styles` | 5.2.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `array.prototype.tosorted` | 1.1.4 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `boolbase` | 1.0.0 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-exp.txt | none |
| Expensify | `call-bind` | 1.0.8 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `call-bind-apply-helpers` | 1.0.2 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `call-bound` | 1.0.4 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `camelize` | 1.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `color-name` | 1.1.4 | missed-TP | version-missing | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `crypto-js` | 4.2.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `css-color-keywords` | 1.0.0 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-exp.txt | none |
| Expensify | `css-tree` | 1.1.3 | missed-TP | version-missing | 111 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `d3-path` | 3.1.0 | missed-TP | version-missing(at hbc98) | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `d3-transition` | 3.0.1 | missed-TP | version-missing | 29 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `date-fns` | 4.1.0 | missed-TP | version-missing(at hbc98) | 365 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `date-fns-tz` | 3.2.0 | missed-TP | not-in-DB | 13 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `debounce` | 2.2.0 | missed-TP | version-missing(at hbc98) | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `decode-uri-component` | 0.2.2 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-exp.txt | none |
| Expensify | `define-data-property` | 1.1.4 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `dijkstrajs` | 1.0.3 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `domelementtype` | 2.3.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `domutils` | 3.2.2 | missed-TP | not-in-DB | 24 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `dunder-proto` | 1.0.1 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `entities` | 2.2.0 | missed-TP | not-in-DB | 28 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `es-abstract` | 1.24.0 | missed-TP | not-in-DB | 44 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `es-define-property` | 1.0.1 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-exp.txt | none |
| Expensify | `es-errors` | 1.3.0 | missed-TP | not-in-DB | 7 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `es-object-atoms` | 1.1.1 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `es-shim-unscopables` | 1.1.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `es-to-primitive` | 1.3.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `escape-string-regexp` | 4.0.0 | missed-TP | version-missing | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `expensify-common` | 2.0.198 | missed-TP | not-in-DB | 26 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `expo` | 57.0.8 | missed-TP | no-HBC-build(hbc98) | 33 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `expo-asset` | 57.0.7 | missed-TP | not-in-DB | 12 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `expo-audio` | 57.0.3 | missed-TP | not-in-DB | 9 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `expo-constants` | 57.0.7 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `expo-image` | 57.0.1 | missed-TP | not-in-DB | 10 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `expo-image-manipulator` | 57.0.6 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `expo-keep-awake` | 57.0.1 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `expo-location` | 57.0.6 | missed-TP | not-in-DB | 7 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `expo-store-review` | 57.0.1 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `expo-task-manager` | 57.0.6 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `expo-video` | 57.0.2 | missed-TP | not-in-DB | 8 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `expo-web-browser` | 57.0.2 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `fast-deep-equal` | 3.1.3 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-exp.txt | none |
| Expensify | `filter-obj` | 1.1.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `function-bind` | 1.1.2 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `function.prototype.name` | 1.1.8 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `geojson-rbush` | 3.2.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `get-intrinsic` | 1.3.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `get-proto` | 1.0.1 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `gopd` | 1.2.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `has-property-descriptors` | 1.0.2 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-exp.txt | none |
| Expensify | `has-symbols` | 1.1.0 | missed-TP | tiny | 2 | out/tri1110.json; out/tiny-exp.txt | none |
| Expensify | `has-tostringtag` | 1.0.2 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-exp.txt | none |
| Expensify | `hasown` | 2.0.2 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-exp.txt | none |
| Expensify | `html-entities` | 2.5.3 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `ieee754` | 1.2.1 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-exp.txt | none |
| Expensify | `internmap` | 2.0.3 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `invariant` | 2.2.4 | missed-TP | version-missing(at hbc98) | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `is-arrayish` | 0.3.2 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `is-callable` | 1.2.7 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-exp.txt | none |
| Expensify | `is-date-object` | 1.1.0 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-exp.txt | none |
| Expensify | `is-regex` | 1.2.1 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-exp.txt | none |
| Expensify | `is-symbol` | 1.1.1 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-exp.txt | none |
| Expensify | `its-fine` | 1.2.5 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `jquery` | 3.6.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `lodash.debounce` | 4.0.8 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-exp.txt | none |
| Expensify | `lodash.isequal` | 4.5.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `lodash.isobject` | 3.0.2 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `lru-cache` | 6.0.0 | missed-TP | version-missing | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `math-intrinsics` | 1.1.0 | missed-TP | not-in-DB | 12 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `metro-runtime` | 0.84.4 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `mime-db` | 1.52.0 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-exp.txt | none |
| Expensify | `nanoid` | 3.3.12 | missed-TP | version-missing | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `nullthrows` | 1.1.1 | missed-TP | no-HBC-build(hbc98) | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `object-inspect` | 1.13.4 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `pako` | 2.1.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `pretty-format` | 29.7.0 | missed-TP | not-in-DB | 10 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `query-string` | 7.1.3 | missed-TP | version-missing | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `rbush` | 3.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `react` | 19.2.3 | missed-TP | version-missing | 9 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `react-content-loader` | 7.0.0 | missed-TP | version-missing | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `react-devtools-core` | 6.1.5 | missed-TP | version-missing | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `react-freeze` | 1.0.3 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-exp.txt | none |
| Expensify | `react-native-advanced-input-mask` | 1.4.6 | missed-TP | not-in-DB | 5 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `react-native-app-logs` | 0.3.1 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `react-native-config` | 1.5.3 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-exp.txt | none |
| Expensify | `react-native-draggable-flatlist` | 4.0.3 | missed-TP | not-in-DB | 22 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `react-native-google-places-autocomplete` | 2.6.4 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `react-native-haptic-feedback` | 2.3.3 | missed-TP | version-missing(at hbc98) | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `react-native-image-size` | 1.1.3 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `react-native-is-edge-to-edge` | 1.3.1 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-exp.txt | none |
| Expensify | `react-native-key-command` | 1.0.14 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `react-native-keyboard-controller` | 1.22.2 | missed-TP | not-in-DB | 56 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `react-native-localize` | 3.5.4 | missed-TP | version-missing | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `react-native-nitro-fetch` | 1.5.4 | missed-TP | not-in-DB | 12 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `react-native-nitro-sqlite` | 9.6.0 | missed-TP | not-in-DB | 20 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `react-native-onyx` | 3.0.100 | missed-TP | not-in-DB | 30 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `react-native-pdf` | 7.0.2 | missed-TP | not-in-DB | 8 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `react-native-picker-select` | 9.3.1 | missed-TP | not-in-DB | 5 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `react-native-plaid-link-sdk` | 12.5.3 | missed-TP | not-in-DB | 8 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `react-native-qrcode-svg` | 6.3.21 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `react-native-tab-view` | 4.3.0 | missed-TP | not-in-DB | 12 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `react-native-view-shot` | 5.1.0 | missed-TP | version-missing | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `react-refresh` | 0.14.2 | missed-TP | version-missing | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `safe-regex-test` | 1.1.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `semver` | 7.7.3 | missed-TP | not-in-DB | 65 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `set-function-length` | 1.2.2 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `set-proto` | 1.0.0 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `side-channel` | 1.1.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `side-channel-list` | 1.0.1 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-exp.txt | none |
| Expensify | `side-channel-map` | 1.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `side-channel-weakmap` | 1.0.2 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `simple-swizzle` | 0.2.2 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `simply-deferred` | 3.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `source-map` | 0.6.1 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | recovered by transub stack (db-growth + metamask-fp + transitive-subtract) |
| Expensify | `split-on-first` | 1.1.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `stacktrace-parser` | 0.1.11 | missed-TP | version-missing(at hbc98) | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `strict-uri-encode` | 2.0.0 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-exp.txt | none |
| Expensify | `string.prototype.trim` | 1.2.10 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `stringify-entities` | 3.1.0 | missed-TP | not-in-DB | 12 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `urijs` | 1.19.11 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `use-latest-callback` | 0.2.6 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `use-sync-external-store` | 1.5.0 | missed-TP | version-missing | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `utf8` | 3.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `victory-native` | 41.21.0 | missed-TP | not-in-DB | 67 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `warn-once` | 0.1.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `webidl-conversions` | 5.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `whatwg-url-without-unicode` | 8.0.0-3 | missed-TP | not-in-DB | 10 | out/tri1110.json; deps-rm/f-v4 listing | recovered by transub stack (db-growth + metamask-fp + transitive-subtract) |
| Expensify | `xlsx` | 0.18.5 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `xtend` | 4.0.2 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-exp.txt | none |
| Expensify | `yallist` | 4.0.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| Expensify | `dagre` | 0.8.5 | FP (both) | copies (hits in lodash); owners: lodash 346, semver 33, ramda 23, <app> 16 |  | deps-mm-fp-dumps/exp.dump.json | none |
| Expensify | `globalthis` | 1.0.4 | FP (base only) | copies (hits in object-keys); owners: object-keys 8, define-data-property 3, string.prototype.trim 2 |  | deps-mm-fp-dumps/exp.dump.json | transub stack (db-growth + metamask-fp + transitive-subtract) |
| Expensify | `lodash-es` | 4.18.1 | FP (both) | truth-noise? (hits mostly in app-owned modules); owners: <app> 72, lodash 58, lodash.isobject 2, expensify-common 2 |  | deps-mm-fp-dumps/exp.dump.json | none |
| Expensify | `readable-stream` | 4.5.2 | FP (base only) | copies (hits in ieee754); owners: ieee754 48, @rnmapbox/maps 5, @sentry/core 4, <app> 4 |  | deps-mm-fp-dumps/exp.dump.json | transub stack (db-growth + metamask-fp + transitive-subtract) |
| Expensify | `source-map-js` | 1.2.1 | FP (base only) | copies (fork/rename of source-map); owners: source-map 35, css-tree 3 |  | deps-mm-fp-dumps/exp.dump.json | transub stack (db-growth + metamask-fp + transitive-subtract) |
| Expensify | `victory` | 37.3.6 | FP (both) | copies (hits in lodash); owners: lodash 34, <app> 22, date-fns 2, @shopify/react-native-skia 2 |  | deps-mm-fp-dumps/exp.dump.json | none |
| Expensify | `whatwg-url` | 15.1.0 | FP (base only) | copies (fork/rename of whatwg-url-without-unicode); owners: whatwg-url-without-unicode 14, webidl-conversions 7, buffer 4, css-tree 2 |  | deps-mm-fp-dumps/exp.dump.json | transub stack (db-growth + metamask-fp + transitive-subtract) |
| react-navigation | `@babel/runtime` | ? | missed-TP | not-in-DB | 12 | out/tri1110.json; out/cls-nav.txt | none (DB wishlist) |
| react-navigation | `@expo-google-fonts/nunito` | ? | missed-TP | not-in-DB | 2 | out/tri1110.json; out/cls-nav.txt | none (DB wishlist) |
| react-navigation | `@expo-google-fonts/outfit` | ? | missed-TP | not-in-DB | 2 | out/tri1110.json; out/cls-nav.txt | none (DB wishlist) |
| react-navigation | `@expo-google-fonts/roboto-slab` | ? | missed-TP | not-in-DB | 2 | out/tri1110.json; out/cls-nav.txt | none (DB wishlist) |
| react-navigation | `@expo-google-fonts/space-grotesk` | ? | missed-TP | not-in-DB | 2 | out/tri1110.json; out/cls-nav.txt | none (DB wishlist) |
| react-navigation | `@expo/react-native-action-sheet` | ? | missed-TP | not-in-DB | 8 | out/tri1110.json; out/cls-nav.txt | none (DB wishlist) |
| react-navigation | `@react-native-async-storage/async-storage` | ? | missed-TP | below-bar(fn-only) | 6 | out/tri1110.json; out/cls-nav.txt | none |
| react-navigation | `@react-native-vector-icons/common` | ? | missed-TP | no-HBC-build(hbc98) | 7 | out/tri1110.json; out/cls-nav.txt | none (DB wishlist) |
| react-navigation | `@react-native-vector-icons/feather` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; out/cls-nav.txt | none (DB wishlist) |
| react-navigation | `@react-native-vector-icons/ionicons` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; out/cls-nav.txt | none (DB wishlist) |
| react-navigation | `@react-native-vector-icons/material-design-icons` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; out/cls-nav.txt | none (DB wishlist) |
| react-navigation | `@react-native/assets-registry` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; out/cls-nav.txt | none (DB wishlist) |
| react-navigation | `@react-native/virtualized-lists` | ? | missed-TP | below-bar(fn-only) | 15 | out/tri1110.json; out/cls-nav.txt | none |
| react-navigation | `@react-navigation/bottom-tabs` | 8.0.0-alpha.50 | missed-TP | not-in-DB(no-code-modules) | 0 | out/tri1110.json; out/cls-nav.txt | none |
| react-navigation | `@react-navigation/core` | 8.0.0-alpha.34 | missed-TP | version-missing | 0 | out/tri1110.json; out/cls-nav.txt | none |
| react-navigation | `@react-navigation/devtools` | 8.0.0-alpha.35 | missed-TP | not-in-DB(no-code-modules) | 0 | out/tri1110.json; out/cls-nav.txt | none |
| react-navigation | `@react-navigation/drawer` | 8.0.0-alpha.51 | missed-TP | not-in-DB(no-code-modules) | 0 | out/tri1110.json; out/cls-nav.txt | none |
| react-navigation | `@react-navigation/elements` | 3.0.0-alpha.48 | missed-TP | not-in-DB(no-code-modules) | 0 | out/tri1110.json; out/cls-nav.txt | none |
| react-navigation | `@react-navigation/native-stack` | 8.0.0-alpha.52 | missed-TP | not-in-DB(no-code-modules) | 0 | out/tri1110.json; out/cls-nav.txt | none |
| react-navigation | `@react-navigation/routers` | 8.0.0-alpha.17 | missed-TP | version-missing | 0 | out/tri1110.json; out/cls-nav.txt | none |
| react-navigation | `@tanstack/query-core` | ? | missed-TP | below-bar(fn-only) | 24 | out/tri1110.json; out/cls-nav.txt | none |
| react-navigation | `@tanstack/react-query` | ? | missed-TP | below-bar(fn-only) | 22 | out/tri1110.json; out/cls-nav.txt | none |
| react-navigation | `@ungap/structured-clone` | ? | missed-TP | not-in-DB | 4 | out/tri1110.json; out/cls-nav.txt | none (DB wishlist) |
| react-navigation | `decode-uri-component` | ? | missed-TP | tiny | 1 | out/tri1110.json; out/cls-nav.txt | none |
| react-navigation | `escape-string-regexp` | ? | missed-TP | tiny | 1 | out/tri1110.json; out/cls-nav.txt | none |
| react-navigation | `expo` | ? | missed-TP | no-HBC-build(hbc98) | 34 | out/tri1110.json; out/cls-nav.txt | none (DB wishlist) |
| react-navigation | `expo-asset` | ? | missed-TP | not-in-DB | 12 | out/tri1110.json; out/cls-nav.txt | none (DB wishlist) |
| react-navigation | `expo-blur` | ? | missed-TP | tiny | 4 | out/tri1110.json; out/cls-nav.txt | none |
| react-navigation | `expo-constants` | ? | missed-TP | not-in-DB | 3 | out/tri1110.json; out/cls-nav.txt | none (DB wishlist) |
| react-navigation | `expo-font` | ? | missed-TP | not-in-DB | 10 | out/tri1110.json; out/cls-nav.txt | none (DB wishlist) |
| react-navigation | `expo-linking` | ? | missed-TP | not-in-DB | 6 | out/tri1110.json; out/cls-nav.txt | none (DB wishlist) |
| react-navigation | `expo-modules-core` | ? | missed-TP | below-bar(fn-only) | 27 | out/tri1110.json; out/cls-nav.txt | none |
| react-navigation | `expo-splash-screen` | ? | missed-TP | not-in-DB | 2 | out/tri1110.json; out/cls-nav.txt | none (DB wishlist) |
| react-navigation | `expo-status-bar` | ? | missed-TP | below-bar(fn-only) | 2 | out/tri1110.json; out/cls-nav.txt | none |
| react-navigation | `fast-deep-equal` | ? | missed-TP | tiny | 1 | out/tri1110.json; out/cls-nav.txt | none |
| react-navigation | `filter-obj` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; out/cls-nav.txt | none (DB wishlist) |
| react-navigation | `hoist-non-react-statics` | ? | missed-TP | tiny | 1 | out/tri1110.json; out/cls-nav.txt | none |
| react-navigation | `invariant` | ? | missed-TP | tiny | 1 | out/tri1110.json; out/cls-nav.txt | none |
| react-navigation | `nanoid` | ? | missed-TP | version-drift(fuzzy-only) | 1 | out/tri1110.json; out/cls-nav.txt | none |
| react-navigation | `nullthrows` | ? | missed-TP | no-HBC-build(hbc98) | 1 | out/tri1110.json; out/cls-nav.txt | none (DB wishlist) |
| react-navigation | `promise` | ? | missed-TP | below-bar(fn-only) | 3 | out/tri1110.json; out/cls-nav.txt | none |
| react-navigation | `query-string` | ? | missed-TP | not-candidate | 2 | out/tri1110.json; out/cls-nav.txt | none |
| react-navigation | `react-freeze` | ? | missed-TP | tiny | 1 | out/tri1110.json; out/cls-nav.txt | none |
| react-navigation | `react-is` | ? | missed-TP | tiny | 4 | out/tri1110.json; out/cls-nav.txt | none |
| react-navigation | `react-native-drawer-layout` | 5.0.0-alpha.18 | missed-TP | not-in-DB(no-code-modules) | 0 | out/tri1110.json; out/cls-nav.txt | none |
| react-navigation | `react-native-showtime` | ? | missed-TP | not-in-DB | 2 | out/tri1110.json; out/cls-nav.txt | none (DB wishlist) |
| react-navigation | `react-native-tab-view` | 5.0.0-alpha.15 | missed-TP | not-in-DB(no-code-modules) | 0 | out/tri1110.json; out/cls-nav.txt | none |
| react-navigation | `semver` | ? | missed-TP | not-in-DB | 21 | out/tri1110.json; out/cls-nav.txt | none (DB wishlist) |
| react-navigation | `split-on-first` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; out/cls-nav.txt | none (DB wishlist) |
| react-navigation | `stacktrace-parser` | ? | missed-TP | tiny | 1 | out/tri1110.json; out/cls-nav.txt | none |
| react-navigation | `standard-navigation` | ? | missed-TP | tiny | 1 | out/tri1110.json; out/cls-nav.txt | none |
| react-navigation | `use-latest-callback` | ? | missed-TP | not-in-DB | 2 | out/tri1110.json; out/cls-nav.txt | none (DB wishlist) |
| react-navigation | `use-sync-external-store` | ? | missed-TP | tiny | 2 | out/tri1110.json; out/cls-nav.txt | none |
| react-navigation | `warn-once` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; out/cls-nav.txt | none (DB wishlist) |
| bluesky | `@atproto/common-web` | ? | missed-TP | not-in-DB | 12 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@atproto/lex` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@atproto/lex-client` | ? | missed-TP | not-in-DB | 33 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@atproto/lex-data` | ? | missed-TP | not-in-DB | 19 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@atproto/lex-json` | ? | missed-TP | not-in-DB | 5 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@atproto/lex-password-session` | ? | missed-TP | not-in-DB | 18 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@atproto/lex-schema` | ? | missed-TP | not-in-DB | 54 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@atproto/syntax` | ? | missed-TP | not-in-DB | 13 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@babel/runtime` | ? | missed-TP | not-in-DB | 5 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@braintree/sanitize-url` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@bsky.app/alf` | ? | missed-TP | not-in-DB | 12 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@bsky.app/expo-dynamic-app-icon` | ? | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@bsky.app/expo-guess-language` | ? | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@bsky.app/expo-image-crop-tool` | ? | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@bsky.app/expo-scroll-edge-effect` | ? | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@bsky.app/expo-translate-text` | ? | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@bsky.app/peek-menu` | ? | missed-TP | not-in-DB | 9 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@bsky.app/react-native-uitextview` | ? | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@bsky.app/sift` | ? | missed-TP | not-in-DB | 5 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@bsky.app/tapper` | ? | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@bsky.app/video` | ? | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@bsky.app/video-compressor` | ? | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@bsky/sdk` | ? | missed-TP | not-in-DB | 612 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@formatjs/bigdecimal` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@formatjs/fast-memoize` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@formatjs/intl-displaynames` | ? | missed-TP | not-in-DB | 42 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@formatjs/intl-getcanonicallocales` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@formatjs/intl-locale` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@formatjs/intl-localematcher` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@formatjs/intl-numberformat` | ? | missed-TP | not-in-DB | 43 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@formatjs/intl-pluralrules` | ? | missed-TP | not-in-DB | 40 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@formatjs/intl-supportedvaluesof` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@growthbook/growthbook` | ? | missed-TP | not-in-DB | 8 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@growthbook/growthbook-react` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@ipld/dag-cbor` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@lingui/core` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@lingui/message-utils` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@lingui/react` | ? | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@messageformat/parser` | ? | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@react-native-async-storage/async-storage` | ? | missed-TP | unknown(below-bar/not-proposed) | 6 | out/tri1110.json; deps-rm/f-v4 listing | none |
| bluesky | `@react-native/assets-registry` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@react-native/virtualized-lists` | ? | missed-TP | unknown(below-bar/not-proposed) | 15 | out/tri1110.json; deps-rm/f-v4 listing | none |
| bluesky | `@react-navigation/bottom-tabs` | ? | missed-TP | not-in-DB | 15 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@react-navigation/elements` | ? | missed-TP | not-in-DB | 31 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@react-navigation/native-stack` | ? | missed-TP | not-in-DB | 10 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@sentry/browser` | ? | missed-TP | not-in-DB | 51 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@sentry/browser-utils` | ? | missed-TP | not-in-DB | 41 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@sentry/conventions` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@sentry/core` | ? | missed-TP | not-in-DB | 167 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@sentry/feedback` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@sentry/react` | ? | missed-TP | not-in-DB | 20 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@tanstack/query-async-storage-persister` | ? | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@tanstack/query-core` | ? | missed-TP | unknown(below-bar/not-proposed) | 24 | out/tri1110.json; deps-rm/f-v4 listing | none |
| bluesky | `@tanstack/query-persist-client-core` | ? | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@tanstack/react-query` | ? | missed-TP | unknown(below-bar/not-proposed) | 22 | out/tri1110.json; deps-rm/f-v4 listing | none |
| bluesky | `@tanstack/react-query-persist-client` | ? | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `@ungap/structured-clone` | ? | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `bcp-47` | ? | missed-TP | not-in-DB | 5 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `bcp-47-match` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `cborg` | ? | missed-TP | not-in-DB | 18 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `color-name` | ? | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-bsky.txt | none |
| bluesky | `css-mediaquery` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `date-fns` | ? | missed-TP | unknown(below-bar/not-proposed) | 516 | out/tri1110.json; deps-rm/f-v4 listing | none |
| bluesky | `decode-uri-component` | ? | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-bsky.txt | none |
| bluesky | `dijkstrajs` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `dom-mutator` | ? | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `email-validator` | ? | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-bsky.txt | none |
| bluesky | `emoji-regex` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `escape-string-regexp` | ? | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-bsky.txt | none |
| bluesky | `expo` | ? | missed-TP | no-HBC-build(hbc98) | 37 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `expo-age-range` | ? | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `expo-application` | ? | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `expo-asset` | ? | missed-TP | not-in-DB | 12 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `expo-blur` | ? | missed-TP | unknown(below-bar/not-proposed) | 4 | out/tri1110.json; deps-rm/f-v4 listing | none |
| bluesky | `expo-camera` | ? | missed-TP | not-in-DB | 7 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `expo-clipboard` | ? | missed-TP | not-in-DB | 5 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `expo-constants` | ? | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `expo-contacts` | ? | missed-TP | not-in-DB | 11 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `expo-device` | ? | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `expo-file-system` | ? | missed-TP | not-in-DB | 21 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `expo-font` | ? | missed-TP | not-in-DB | 11 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `expo-glass-effect` | ? | missed-TP | unknown(below-bar/not-proposed) | 5 | out/tri1110.json; deps-rm/f-v4 listing | none |
| bluesky | `expo-haptics` | ? | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `expo-image` | ? | missed-TP | not-in-DB | 10 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `expo-image-manipulator` | ? | missed-TP | not-in-DB | 5 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `expo-image-picker` | ? | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `expo-intent-launcher` | ? | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `expo-keep-awake` | ? | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `expo-linear-gradient` | ? | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `expo-linking` | ? | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `expo-localization` | ? | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `expo-location` | ? | missed-TP | not-in-DB | 7 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `expo-media-library` | ? | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `expo-modules-core` | ? | missed-TP | unknown(below-bar/not-proposed) | 27 | out/tri1110.json; deps-rm/f-v4 listing | none |
| bluesky | `expo-notifications` | ? | missed-TP | not-in-DB | 55 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `expo-paste-input` | ? | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `expo-privacy-sensitive` | ? | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `expo-screen-orientation` | ? | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `expo-sharing` | ? | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `expo-sms` | ? | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `expo-splash-screen` | ? | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `expo-system-ui` | ? | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `expo-updates` | ? | missed-TP | not-in-DB | 9 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `expo-video` | ? | missed-TP | not-in-DB | 8 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `expo-video-thumbnails` | ? | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `expo-web-browser` | ? | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `fast-deep-equal` | ? | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-bsky.txt | none |
| bluesky | `filter-obj` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `fuse.js` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `hyphenate-style-name` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `invariant` | ? | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-bsky.txt | none |
| bluesky | `is-alphabetical` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `is-alphanumerical` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `is-arrayish` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `is-decimal` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `iso-datestring-validator` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `js-sha256` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `jwt-decode` | ? | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-bsky.txt | none |
| bluesky | `lande` | ? | missed-TP | not-in-DB | 5 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `libphonenumber-js` | ? | missed-TP | unknown(below-bar/not-proposed) | 90 | out/tri1110.json; deps-rm/f-v4 listing | none |
| bluesky | `lodash.chunk` | ? | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-bsky.txt | none |
| bluesky | `lodash.shuffle` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `matchmediaquery` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `metro-runtime` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `multiformats` | ? | missed-TP | not-in-DB | 13 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `nanoid` | ? | missed-TP | unknown(below-bar/not-proposed) | 3 | out/tri1110.json; deps-rm/f-v4 listing | none |
| bluesky | `nullthrows` | ? | missed-TP | no-HBC-build(hbc98) | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `query-string` | ? | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-bsky.txt | none |
| bluesky | `react-fast-compare` | ? | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-bsky.txt | none |
| bluesky | `react-freeze` | ? | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-bsky.txt | none |
| bluesky | `react-is` | ? | missed-TP | unknown(below-bar/not-proposed) | 4 | out/tri1110.json; deps-rm/f-v4 listing | none |
| bluesky | `react-keyed-flatten-children` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `react-native-compressor` | ? | missed-TP | not-in-DB | 9 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `react-native-device-attest` | ? | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `react-native-drawer-layout` | ? | missed-TP | not-in-DB | 9 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `react-native-keyboard-controller` | ? | missed-TP | not-in-DB | 52 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `react-native-mmkv` | ? | missed-TP | unknown(below-bar/not-proposed) | 11 | out/tri1110.json; deps-rm/f-v4 listing | none |
| bluesky | `react-native-progress` | ? | missed-TP | unknown(below-bar/not-proposed) | 9 | out/tri1110.json; deps-rm/f-v4 listing | none |
| bluesky | `react-native-qrcode-styled` | ? | missed-TP | not-in-DB | 12 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `react-native-view-shot` | ? | missed-TP | tiny | 3 | out/tri1110.json; out/tiny-bsky.txt | none |
| bluesky | `semver` | ? | missed-TP | not-in-DB | 21 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `simple-swizzle` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `sonner-native` | ? | missed-TP | not-in-DB | 22 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `split-on-first` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `stacktrace-parser` | ? | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-bsky.txt | none |
| bluesky | `strict-uri-encode` | ? | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-bsky.txt | none |
| bluesky | `toygrad` | ? | missed-TP | not-in-DB | 32 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `unicode-segmenter` | ? | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `use-latest-callback` | ? | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `use-sync-external-store` | ? | missed-TP | tiny | 2 | out/tri1110.json; out/tiny-bsky.txt | none |
| bluesky | `warn-once` | ? | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| bluesky | `zod` | ? | missed-TP | unknown(below-bar/not-proposed) | 9 | out/tri1110.json; deps-rm/f-v4 listing | none |
| bluesky | `@react-navigation/material-top-tabs` | 8.0.0-alpha.49 | FP (both) | copies (hits in @react-navigation/elements); owners: @react-navigation/elements 26, use-sync-external-store 6, react-native 2, <app> 2 |  | deps-mm-fp-dumps/bsky.dump.json | none |
| rainbow | `@babel/runtime` | 7.27.1 | missed-TP | not-in-DB | 77 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@bankify/react-native-animate-number` | 0.2.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@bivoglobal/payment-react-native` | 0.0.2 | missed-TP | not-in-DB | 7 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@bradgarropy/use-countdown` | 1.4.1 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@candlefinance/faster-image` | 1.6.2 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@capsizecss/core` | 3.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@coinbase/mobile-wallet-protocol-host` | 0.1.7 | missed-TP | not-in-DB | 16 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@dominicstop/ts-event-emitter` | 1.1.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@domir/react-native-measure-text` | 0.1.8 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@emotion/is-prop-valid` | 0.8.8 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@emotion/memoize` | 0.7.4 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@emotion/stylis` | 0.8.5 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@emotion/unitless` | 0.7.5 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ensdomains/address-encoder` | 0.2.16 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ensdomains/content-hash` | 2.5.7 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ensdomains/eth-ens-namehash` | 2.0.15 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ethereumjs/rlp` | 4.0.1 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ethereumjs/util` | 8.1.0 | missed-TP | not-in-DB | 49 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ethersproject/abi` | 5.8.0 | missed-TP | not-in-DB | 16 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ethersproject/abstract-provider` | 5.8.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ethersproject/abstract-signer` | 5.8.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ethersproject/address` | 5.8.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ethersproject/base64` | 5.8.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ethersproject/basex` | 5.8.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ethersproject/bignumber` | 5.8.0 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ethersproject/bytes` | 5.8.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ethersproject/constants` | 5.8.0 | missed-TP | not-in-DB | 5 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ethersproject/contracts` | 5.8.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ethersproject/hash` | 5.8.0 | missed-TP | not-in-DB | 9 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ethersproject/hdnode` | 5.8.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ethersproject/json-wallets` | 5.8.0 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ethersproject/keccak256` | 5.8.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ethersproject/logger` | 5.8.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ethersproject/networks` | 5.8.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ethersproject/pbkdf2` | 5.8.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ethersproject/properties` | 5.8.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ethersproject/providers` | 5.8.0 | missed-TP | not-in-DB | 20 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ethersproject/random` | 5.8.0 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ethersproject/rlp` | 5.8.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ethersproject/sha2` | 5.8.0 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ethersproject/shims` | 5.8.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ethersproject/signing-key` | 5.8.0 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ethersproject/solidity` | 5.8.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ethersproject/strings` | 5.8.0 | missed-TP | not-in-DB | 5 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ethersproject/transactions` | 5.8.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ethersproject/units` | 5.8.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ethersproject/wallet` | 5.8.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ethersproject/web` | 5.8.0 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ethersproject/wordlists` | 5.8.0 | missed-TP | not-in-DB | 12 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@gorhom/bottom-sheet` | 5.2.8 | missed-TP | not-in-DB | 89 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@gorhom/portal` | 1.0.14 | missed-TP | not-in-DB | 9 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@json-rpc-tools/types` | 1.7.6 | missed-TP | not-in-DB | 9 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@json-rpc-tools/utils` | 1.7.6 | missed-TP | not-in-DB | 8 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ledgerhq/cryptoassets-evm-signatures` | 13.5.0 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ledgerhq/devices` | 8.4.5 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ledgerhq/domain-service` | 1.2.6 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ledgerhq/errors` | 6.19.1 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ledgerhq/evm-tools` | 1.2.3 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ledgerhq/hw-app-eth` | 6.39.0 | missed-TP | not-in-DB | 11 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ledgerhq/hw-transport` | 6.34.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ledgerhq/live-env` | 2.3.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ledgerhq/logs` | 6.16.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ledgerhq/react-native-hw-transport-ble` | 6.34.1 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@legendapp/list` | 2.0.16 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@metamask/abi-utils` | 2.0.4 | missed-TP | not-in-DB | 20 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@metamask/eth-sig-util` | 7.0.2 | missed-TP | not-in-DB | 15 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@metamask/superstruct` | 3.1.0 | missed-TP | not-in-DB | 8 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@metamask/utils` | 8.5.0 | missed-TP | not-in-DB | 42 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@motionone/animation` | 10.18.0 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@motionone/dom` | 10.12.0 | missed-TP | not-in-DB | 46 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@motionone/easing` | 10.18.0 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@motionone/generators` | 10.18.0 | missed-TP | not-in-DB | 8 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@motionone/types` | 10.17.1 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@motionone/utils` | 10.18.0 | missed-TP | not-in-DB | 19 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@multiformats/base-x` | 4.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@nktkas/hyperliquid` | 0.32.2 | missed-TP | not-in-DB | 185 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@nktkas/rews` | 2.1.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@noble/curves` | 1.9.1 | missed-TP | not-in-DB | 31 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@noble/hashes` | 1.8.0 | missed-TP | not-in-DB | 42 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@notifee/react-native` | 7.8.2 | missed-TP | version-missing(at hbc96) | 32 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@openzeppelin/merkle-tree` | 1.0.8 | missed-TP | not-in-DB | 9 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@pedrouid/environment` | 1.0.1 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@polymarket/builder-abstract-signer` | 0.0.1 | missed-TP | not-in-DB | 7 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@polymarket/builder-relayer-client` | 0.0.10 | missed-TP | not-in-DB | 26 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@polymarket/builder-signing-sdk` | 0.0.8 | missed-TP | not-in-DB | 7 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@polymarket/clob-client-v2` | 1.1.0 | missed-TP | not-in-DB | 38 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@rainbow-me/provider` | 0.1.2 | missed-TP | not-in-DB | 7 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@rainbow-me/sdk` | 0.4.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@rainbow-me/swaps` | 0.41.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@rainbow-me/token-launcher` | 0.3.0 | missed-TP | not-in-DB | 10 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@react-native-camera-roll/camera-roll` | 7.10.0 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@react-native-firebase/firestore` | 23.8.8 | missed-TP | not-in-DB | 37 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@react-native-firebase/messaging` | 23.8.8 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@react-native-firebase/remote-config` | 23.8.8 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@react-native-masked-view/masked-view` | 0.3.2 | missed-TP | version-missing(at hbc96) | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@react-native-menu/menu` | 2.0.0 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@react-native/assets-registry` | 0.81.6 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@react-native/normalize-color` | 2.1.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@react-navigation/core` | 6.4.17 | missed-TP | no-HBC-build(hbc96) | 59 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@react-navigation/elements` | 1.3.31 | missed-TP | not-in-DB | 20 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@react-navigation/material-top-tabs` | 6.6.2 | missed-TP | no-HBC-build(hbc96) | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@reown/walletkit` | 1.1.2 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@rudderstack/rudder-sdk-react-native` | 2.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@scure/base` | 1.2.4 | missed-TP | not-in-DB | 5 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@scure/bip32` | 1.7.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@scure/bip39` | 1.6.0 | missed-TP | not-in-DB | 11 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@sentry-internal/browser-utils` | 10.38.0 | missed-TP | not-in-DB | 37 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@sentry-internal/feedback` | 10.38.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@sentry-internal/replay` | 10.38.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@sentry-internal/replay-canvas` | 10.38.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@sentry/browser` | 10.38.0 | missed-TP | not-in-DB | 44 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@sentry/core` | 10.38.0 | missed-TP | not-in-DB | 352 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@sentry/react` | 10.38.0 | missed-TP | not-in-DB | 17 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@shopify/react-native-performance` | 4.1.2 | missed-TP | not-in-DB | 47 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@stablelib/binary` | 1.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@stablelib/chacha` | 1.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@stablelib/chacha20poly1305` | 1.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@stablelib/constant-time` | 1.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@stablelib/ed25519` | 1.0.3 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@stablelib/hash` | 1.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@stablelib/hkdf` | 1.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@stablelib/hmac` | 1.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@stablelib/int` | 1.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@stablelib/poly1305` | 1.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@stablelib/random` | 1.0.2 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@stablelib/sha256` | 1.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@stablelib/sha512` | 1.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@stablelib/wipe` | 1.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@stablelib/x25519` | 1.0.3 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@storesjs/stores` | 0.11.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@tanstack/react-query` | 4.2.1 | missed-TP | version-missing | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@tanstack/react-query-persist-client` | 4.2.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@tradle/react-native-http` | 2.0.1 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@ungap/structured-clone` | 1.3.0 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@unstoppabledomains/resolution` | 7.1.4 | missed-TP | not-in-DB | 24 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@walletconnect/core` | 2.17.0 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@walletconnect/environment` | 1.0.1 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@walletconnect/events` | 1.0.1 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@walletconnect/heartbeat` | 1.2.2 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@walletconnect/jsonrpc-provider` | 1.0.14 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@walletconnect/jsonrpc-types` | 1.0.4 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@walletconnect/jsonrpc-utils` | 1.0.8 | missed-TP | not-in-DB | 9 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@walletconnect/jsonrpc-ws-connection` | 1.0.14 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@walletconnect/keyvaluestorage` | 1.1.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@walletconnect/logger` | 2.1.2 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@walletconnect/react-native-compat` | 2.17.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@walletconnect/relay-api` | 1.0.11 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@walletconnect/relay-auth` | 1.0.4 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@walletconnect/safe-json` | 1.0.2 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@walletconnect/sign-client` | 2.17.3 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@walletconnect/time` | 1.0.2 | missed-TP | not-in-DB | 10 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@walletconnect/types` | 2.17.0 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@walletconnect/utils` | 2.17.0 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@walletconnect/window-getters` | 1.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `@walletconnect/window-metadata` | 1.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `Base64` | 0.2.1 | missed-TP | version-missing | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `abort-controller` | 3.0.0 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-rain.txt | none |
| rainbow | `abs-svg-path` | 0.1.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `aes-js` | 3.0.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `asn1.js` | 4.10.1 | missed-TP | version-missing | 14 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `async-mutex` | 0.3.2 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-rain.txt | none |
| rainbow | `available-typed-arrays` | 1.0.7 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-rain.txt | none |
| rainbow | `base-x` | 3.0.10 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-rain.txt | none |
| rainbow | `base64-js` | 1.5.1 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-rain.txt | none |
| rainbow | `bignumber.js` | 9.0.1 | missed-TP | version-missing | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `bip39` | 3.0.2 | missed-TP | no-HBC-build(hbc96) | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `bn.js` | 4.12.0 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `brorand` | 1.1.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `browserify-aes` | 1.2.0 | missed-TP | not-in-DB | 16 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `browserify-cipher` | 1.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `browserify-des` | 1.0.2 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `browserify-rsa` | 4.1.0 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-rain.txt | none |
| rainbow | `browserify-sign` | 4.2.3 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `browserify-zlib` | 0.1.4 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `bs58check` | 2.1.2 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `buffer` | 5.7.1 | missed-TP | tiny | 6 | out/tri1110.json; out/tiny-rain.txt | none |
| rainbow | `buffer-xor` | 1.0.3 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-rain.txt | none |
| rainbow | `call-bind` | 1.0.8 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `call-bind-apply-helpers` | 1.0.2 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `call-bound` | 1.0.4 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `camelize` | 1.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `charenc` | 0.0.2 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-rain.txt | none |
| rainbow | `cids` | 1.1.9 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `cipher-base` | 1.0.4 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `clanker-sdk` | 4.2.16 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `color-convert` | 2.0.1 | missed-TP | version-missing | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `color-name` | 1.1.4 | missed-TP | version-missing | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `conditional-wrap` | 1.0.2 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `core-util-is` | 1.0.3 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-rain.txt | none |
| rainbow | `create-hash` | 1.2.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `create-hmac` | 1.1.7 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `crypt` | 0.0.2 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `crypto-addr-codec` | 0.1.8 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `crypto-js` | 4.2.0 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `css-color-keywords` | 1.0.0 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-rain.txt | none |
| rainbow | `d3-path` | 3.1.0 | missed-TP | version-missing(at hbc96) | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `debug` | 4.4.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `decode-uri-component` | 0.2.2 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-rain.txt | none |
| rainbow | `define-data-property` | 1.1.4 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `delay` | 4.4.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `dequal` | 2.0.3 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `des.js` | 1.1.0 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `detect-browser` | 5.3.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `dijkstrajs` | 1.0.3 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `dunder-proto` | 1.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `elliptic` | 6.6.1 | missed-TP | not-in-DB | 15 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `emoji-regex` | 10.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `es-errors` | 1.3.0 | missed-TP | not-in-DB | 7 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `es-object-atoms` | 1.1.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `escape-string-regexp` | 4.0.0 | missed-TP | version-missing | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `eth-url-parser` | 1.0.4 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `ethereum-cryptography` | 0.1.3 | missed-TP | not-in-DB | 22 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `ethereumjs-util` | 6.2.1 | missed-TP | not-in-DB | 22 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `ethereumjs-wallet` | 1.0.1 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `ethers` | 5.8.0 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `ethjs-util` | 0.1.6 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `event-target-shim` | 5.0.1 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-rain.txt | none |
| rainbow | `eventemitter3` | 5.0.1 | missed-TP | tiny | 2 | out/tri1110.json; out/tiny-rain.txt | none |
| rainbow | `evp_bytestokey` | 1.0.3 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `expo-asset` | 12.0.12 | missed-TP | not-in-DB | 12 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `expo-constants` | 18.0.13 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `expo-image-manipulator` | 14.0.8 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `expo-image-picker` | 17.0.10 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `expo-linear-gradient` | 15.0.8 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `expo-store-review` | 9.0.9 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `expo-web-browser` | 15.0.10 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `extract-files` | 9.0.0 | missed-TP | version-missing | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `fast-base64-decode` | 1.0.0 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-rain.txt | none |
| rainbow | `fbjs` | 0.8.18 | missed-TP | tiny | 2 | out/tri1110.json; out/tiny-rain.txt | none |
| rainbow | `figma-squircle` | 1.1.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `filter-obj` | 1.1.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `for-each` | 0.3.5 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `form-data` | 3.0.1 | missed-TP | version-missing | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `framer-motion` | 6.5.1 | missed-TP | not-in-DB | 182 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `function-bind` | 1.1.2 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `get-intrinsic` | 1.3.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `get-proto` | 1.0.1 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `gopd` | 1.2.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `graphql-request` | 4.3.0 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `graphql-tag` | 2.12.6 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `gretchen` | 1.5.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `has-property-descriptors` | 1.0.2 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-rain.txt | none |
| rainbow | `has-symbols` | 1.1.0 | missed-TP | tiny | 2 | out/tri1110.json; out/tiny-rain.txt | none |
| rainbow | `has-tostringtag` | 1.0.2 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-rain.txt | none |
| rainbow | `hash-base` | 3.1.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `hash.js` | 1.1.7 | missed-TP | not-in-DB | 12 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `hasown` | 2.0.2 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-rain.txt | none |
| rainbow | `hey-listen` | 1.0.8 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `hmac-drbg` | 1.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `https-browserify` | 0.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `i18n-js` | 3.8.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `idna-uts46-hx` | 3.4.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `imgix-core-js` | 2.3.2 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `indexof` | 0.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `inherits` | 2.0.4 | missed-TP | version-missing(at hbc96) | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `internmap` | 2.0.3 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `invariant` | 2.2.4 | missed-TP | version-missing(at hbc96) | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `is-arguments` | 1.1.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `is-arrayish` | 0.3.2 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `is-buffer` | 1.1.6 | missed-TP | version-missing | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `is-callable` | 1.2.7 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-rain.txt | none |
| rainbow | `is-hex-prefixed` | 1.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `isarray` | 1.0.0 | missed-TP | version-missing | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `isows` | 1.0.7 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `js-crc` | 0.2.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `js-sha256` | 0.9.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `js-sha3` | 0.8.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `js-sha512` | 0.8.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `keccak` | 3.0.4 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `linkify-it` | 2.2.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `liquid-sdk` | 1.7.2 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `lodash` | 4.17.21 | missed-TP | demoted-by-bundled-dist | 262 | out/tri1110.json; deps-rm/f-v4 listing | none |
| rainbow | `lodash.debounce` | 4.0.8 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-rain.txt | none |
| rainbow | `lodash.isequal` | 4.5.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `make-color-more-chill` | 0.2.2 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `markdown-it` | 10.0.0 | missed-TP | not-in-DB | 52 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `match-sorter` | 6.3.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `math-intrinsics` | 1.1.0 | missed-TP | not-in-DB | 8 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `md5` | 2.3.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `md5.js` | 1.3.5 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `memoize-one` | 5.2.1 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-rain.txt | none |
| rainbow | `metro-runtime` | 0.83.6 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `micro-ftch` | 0.3.1 | missed-TP | version-missing | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `miller-rabin` | 4.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `minimalistic-assert` | 1.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `mnemonist` | 0.38.1 | missed-TP | version-missing | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `moti` | 0.28.1 | missed-TP | not-in-DB | 15 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `ms` | 2.1.3 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `multibase` | 4.0.6 | missed-TP | not-in-DB | 10 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `multicodec` | 3.2.1 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `multiformats` | 9.9.0 | missed-TP | not-in-DB | 129 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `multihashes` | 4.0.3 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `nano-base32` | 1.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `nanoid` | 3.3.7 | missed-TP | version-missing | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `normalize-svg-path` | 1.1.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `nullthrows` | 1.1.1 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-rain.txt | none |
| rainbow | `object-assign` | 4.1.1 | missed-TP | version-missing(at hbc96) | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `obliterator` | 1.6.1 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `ox` | 0.14.33 | missed-TP | not-in-DB | 76 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `p-timeout` | 5.1.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `p-wait-for` | 4.1.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `pako` | 0.2.9 | missed-TP | not-in-DB | 12 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `parse-asn1` | 5.1.7 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `parse-ms` | 2.1.0 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-rain.txt | none |
| rainbow | `parse-svg-path` | 0.1.2 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-rain.txt | none |
| rainbow | `pbkdf2` | 3.0.8 | missed-TP | not-in-DB | 8 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `pino` | 7.11.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `pony-cause` | 2.1.11 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `popmotion` | 11.0.3 | missed-TP | not-in-DB | 37 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `possible-typed-array-names` | 1.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `process-nextick-args` | 2.0.1 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-rain.txt | none |
| rainbow | `public-encrypt` | 4.0.3 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `punycode` | 2.3.1 | missed-TP | version-missing(at hbc96) | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `query-string` | 7.1.3 | missed-TP | version-missing | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `querystring-es3` | 0.2.1 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `querystringify` | 2.2.0 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-rain.txt | none |
| rainbow | `quick-format-unescaped` | 4.0.4 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-rain.txt | none |
| rainbow | `randombytes` | 2.1.0 | missed-TP | version-missing(at hbc96) | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `randomfill` | 1.0.4 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-rain.txt | none |
| rainbow | `react-fast-compare` | 3.2.2 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-rain.txt | none |
| rainbow | `react-flatten-children` | 1.1.2 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `react-freeze` | 1.0.4 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-rain.txt | none |
| rainbow | `react-is` | 16.13.1 | missed-TP | version-missing | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `react-native-action-sheet` | 2.2.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `react-native-animateable-text` | 0.17.1 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `react-native-appsflyer` | 6.18.0 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `react-native-blur-view` | 1.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `react-native-bootsplash` | 6.3.7 | missed-TP | version-missing | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `react-native-branch` | 5.3.1 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `react-native-change-icon` | 5.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `react-native-cloud-fs` | 2.6.2 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `react-native-crypto` | 2.2.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `react-native-dark-mode` | 0.2.2 | missed-TP | not-in-DB | 11 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `react-native-fast-image` | 8.5.11 | missed-TP | version-missing | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `react-native-get-random-values` | 1.5.0 | missed-TP | version-missing | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `react-native-image-colors` | 2.5.1 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `react-native-indicators` | 0.17.0 | missed-TP | not-in-DB | 20 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `react-native-ios-context-menu` | 1.15.3 | missed-TP | not-in-DB | 21 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `react-native-is-edge-to-edge` | 1.1.7 | missed-TP | version-missing | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `react-native-keyboard-controller` | 1.21.7 | missed-TP | not-in-DB | 53 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `react-native-keychain` | 10.0.0 | missed-TP | version-missing(at hbc96) | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `react-native-minimizer` | 1.3.5 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `react-native-mmkv` | 4.1.2 | missed-TP | no-HBC-build(hbc96) | 17 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `react-native-palette-full` | 1.2.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `react-native-passkeys` | 0.4.1 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `react-native-permissions` | 3.10.1 | missed-TP | version-missing | 7 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `react-native-quick-md5` | 3.0.9 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `react-native-radial-gradient` | 1.0.10 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `react-native-redash` | 16.3.0 | missed-TP | not-in-DB | 14 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `react-native-restart` | 0.0.22 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `react-native-share` | 12.2.5 | missed-TP | version-missing | 11 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `react-native-storage` | 1.0.1 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `react-native-tab-view` | 3.5.2 | missed-TP | not-in-DB | 10 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `react-native-text-input-mask` | 2.0.0 | missed-TP | version-missing | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `react-native-tooltips` | 1.0.4 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `react-native-turbo-haptics` | 1.0.9 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `react-native-url-polyfill` | 2.0.0 | missed-TP | version-missing(at hbc96) | 11 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `react-native-version-number` | 0.3.6 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `react-primitives` | 0.8.1 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `react-redux` | 7.2.1 | missed-TP | version-missing | 23 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `recyclerlistview` | 4.2.3 | missed-TP | no-HBC-build(hbc96) | 59 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `redux-thunk` | 2.3.0 | missed-TP | version-missing | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `remove-accents` | 0.4.2 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `requires-port` | 1.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `reselect` | 4.0.0 | missed-TP | version-missing | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `ripemd160` | 2.0.2 | missed-TP | version-missing | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `ripemd160-min` | 0.0.6 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `rlp` | 2.2.7 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `safe-buffer` | 5.2.1 | missed-TP | version-missing(at hbc96) | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `scrypt-js` | 3.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `semver` | 7.7.1 | missed-TP | not-in-DB | 45 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `set-function-length` | 1.2.2 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `sha3` | 2.1.4 | missed-TP | not-in-DB | 11 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `shallowequal` | 1.1.0 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-rain.txt | none |
| rainbow | `simple-swizzle` | 0.2.2 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `sjcl` | 1.0.8 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `sonner-native` | 0.16.0 | missed-TP | not-in-DB | 16 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `spark-md5` | 3.0.2 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `split-on-first` | 1.1.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `stream-browserify` | 1.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `strict-uri-encode` | 2.0.0 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-rain.txt | none |
| rainbow | `string_decoder` | 0.10.31 | missed-TP | version-missing | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `strip-hex-prefix` | 1.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `style-value-types` | 5.0.0 | missed-TP | not-in-DB | 10 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `styled-components` | 5.2.1 | missed-TP | version-missing | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `supports-color` | 5.5.0 | missed-TP | no-HBC-build(hbc96) | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `svg-arc-to-cubic-bezier` | 3.2.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `symbol-observable` | 1.2.0 | missed-TP | version-missing | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `tiny-invariant` | 1.3.3 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `ts-object-utils` | 0.0.5 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `tweetnacl` | 1.0.3 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `uc.micro` | 1.0.6 | missed-TP | version-missing | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `uint8arrays` | 3.1.1 | missed-TP | not-in-DB | 43 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `url` | 0.10.3 | missed-TP | version-missing | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `url-join` | 4.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `use-debounce` | 10.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `use-latest-callback` | 0.2.1 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `use-memo-one` | 1.1.1 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-rain.txt | none |
| rainbow | `use-sync-external-store` | 1.5.0 | missed-TP | version-missing | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `utf8` | 3.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `util-deprecate` | 1.0.2 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-rain.txt | none |
| rainbow | `valibot` | 1.3.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `w2t` | 3.0.2 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `warn-once` | 0.1.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `web-encoding` | 1.1.5 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-rain.txt | none |
| rainbow | `webidl-conversions` | 5.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `whatwg-url-without-unicode` | 8.0.0-3 | missed-TP | not-in-DB | 10 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `ws` | 7.5.10 | missed-TP | version-missing | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `zeego` | 1.10.0 | missed-TP | not-in-DB | 10 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| rainbow | `d3-geo` | 2.0.2 | FP (base only) | copies (hits in d3-array); owners: d3-array 31, internmap 3, react-native-redash 1, @shopify/react-native-skia 1 |  | deps-mm-fp-dumps/rain.dump.json | transub stack (db-growth + metamask-fp + transitive-subtract) |
| rainbow | `d3-interpolate-path` | 2.3.0 | FP (both) | truth-noise? (hits mostly in app-owned modules); owners: <app> 12, readable-stream 2, @babel/runtime 1 |  | deps-mm-fp-dumps/rain.dump.json | none |
| rainbow | `jszip` | 3.9.0 | FP (both) | copies (hits in pako); owners: pako 25, @tradle/react-native-http 1 |  | deps-mm-fp-dumps/rain.dump.json | none |
| rainbow | `react-query` | 4.0.0 | FP (both) | copies (fork/rename of @tanstack/react-query); owners: @tanstack/react-query 275 |  | deps-mm-fp-dumps/rain.dump.json | none |
| rainbow | `typeorm` | 0.3.31 | FP (both) | truth-noise? (hits mostly in app-owned modules); owners: <app> 119, @nktkas/hyperliquid 87, @polymarket/clob-client-v2 31, @shopify/react-native-skia 19 |  | deps-mm-fp-dumps/rain.dump.json | none |
| rainbow | `wagmi` | 1.4.12 | FP (both) | copies (hits in viem); owners: viem 418, @tanstack/react-query 186, @noble/curves 90, abitype 48 |  | deps-mm-fp-dumps/rain.dump.json | none |
| rainbow | `whatwg-url` | 15.1.0 | FP (both) | copies (fork/rename of whatwg-url-without-unicode); owners: whatwg-url-without-unicode 27 |  | deps-mm-fp-dumps/rain.dump.json | none |
| MetaMask | `@adraffy/ens-normalize` | 1.11.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@babel/runtime` | 7.29.7 | missed-TP | not-in-DB | 58 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@braze/react-native-sdk` | 19.1.0 | missed-TP | not-in-DB | 11 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@consensys/on-ramp-sdk` | 2.1.12 | missed-TP | not-in-DB | 21 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@contentful/rich-text-html-renderer` | 16.6.4 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@craftzdog/react-native-buffer` | 6.1.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ecies/ciphers` | 0.2.6 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ethereumjs/common` | 4.4.0 | missed-TP | not-in-DB | 10 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ethereumjs/rlp` | 4.0.1 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ethereumjs/tx` | 5.4.0 | missed-TP | not-in-DB | 17 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ethereumjs/util` | 8.1.0 | missed-TP | not-in-DB | 51 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ethersproject/abi` | 5.7.0 | missed-TP | not-in-DB | 16 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ethersproject/abstract-provider` | 5.8.0 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ethersproject/abstract-signer` | 5.8.0 | missed-TP | not-in-DB | 8 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ethersproject/address` | 5.8.0 | missed-TP | not-in-DB | 18 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ethersproject/base64` | 5.8.0 | missed-TP | not-in-DB | 18 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ethersproject/basex` | 5.8.0 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ethersproject/bignumber` | 5.8.0 | missed-TP | not-in-DB | 52 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ethersproject/bytes` | 5.8.0 | missed-TP | not-in-DB | 42 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ethersproject/constants` | 5.8.0 | missed-TP | not-in-DB | 55 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ethersproject/contracts` | 5.7.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ethersproject/hash` | 5.8.0 | missed-TP | not-in-DB | 63 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ethersproject/hdnode` | 5.8.0 | missed-TP | not-in-DB | 8 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ethersproject/json-wallets` | 5.8.0 | missed-TP | not-in-DB | 18 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ethersproject/keccak256` | 5.8.0 | missed-TP | not-in-DB | 10 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ethersproject/logger` | 5.8.0 | missed-TP | not-in-DB | 48 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ethersproject/networks` | 5.8.0 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ethersproject/pbkdf2` | 5.8.0 | missed-TP | not-in-DB | 8 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ethersproject/properties` | 5.8.0 | missed-TP | not-in-DB | 26 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ethersproject/providers` | 5.8.0 | missed-TP | not-in-DB | 39 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ethersproject/random` | 5.8.0 | missed-TP | not-in-DB | 20 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ethersproject/rlp` | 5.8.0 | missed-TP | not-in-DB | 20 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ethersproject/sha2` | 5.8.0 | missed-TP | not-in-DB | 24 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ethersproject/signing-key` | 5.8.0 | missed-TP | not-in-DB | 21 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ethersproject/solidity` | 5.7.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ethersproject/strings` | 5.8.0 | missed-TP | not-in-DB | 45 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ethersproject/transactions` | 5.8.0 | missed-TP | not-in-DB | 12 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ethersproject/units` | 5.7.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ethersproject/wallet` | 5.8.0 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ethersproject/web` | 5.8.0 | missed-TP | not-in-DB | 9 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ethersproject/wordlists` | 5.8.0 | missed-TP | not-in-DB | 60 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@expensify/react-native-wallet` | 0.1.15 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@inversifyjs/common` | 1.5.0 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@inversifyjs/container` | 1.9.1 | missed-TP | not-in-DB | 34 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@inversifyjs/core` | 5.2.0 | missed-TP | not-in-DB | 115 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@inversifyjs/prototype-utils` | 0.1.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@inversifyjs/reflect-metadata-utils` | 1.1.0 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@jsamr/counter-style` | 2.0.2 | missed-TP | not-in-DB | 17 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@jsamr/react-native-li` | 2.3.1 | missed-TP | not-in-DB | 5 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@json-schema-spec/json-pointer` | 0.1.2 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@json-schema-tools/dereferencer` | 1.6.3 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@json-schema-tools/meta-schema` | 1.7.5 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@json-schema-tools/reference-resolver` | 1.2.6 | missed-TP | not-in-DB | 5 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@json-schema-tools/traverse` | 1.10.4 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@keystonehq/alias-sampling` | 0.1.2 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@keystonehq/bc-ur-registry` | 0.6.4 | missed-TP | not-in-DB | 72 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@keystonehq/bc-ur-registry-eth` | 0.19.1 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@keystonehq/ur-decoder` | 0.12.2 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ledgerhq/context-module` | 2.3.1 | missed-TP | not-in-DB | 178 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ledgerhq/cryptoassets-evm-signatures` | 13.5.2 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ledgerhq/device-management-kit` | 1.7.1 | missed-TP | not-in-DB | 187 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ledgerhq/device-signer-kit-ethereum` | 1.16.0 | missed-TP | not-in-DB | 100 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ledgerhq/device-transport-kit-react-native-ble` | 1.3.2 | missed-TP | not-in-DB | 9 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ledgerhq/devices` | 8.10.0 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ledgerhq/domain-service` | 1.2.15 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ledgerhq/errors` | 6.35.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ledgerhq/evm-tools` | 1.3.0 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ledgerhq/hw-app-eth` | 6.42.2 | missed-TP | not-in-DB | 14 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ledgerhq/hw-transport` | 6.35.2 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ledgerhq/live-env` | 2.4.1 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ledgerhq/logs` | 6.17.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ledgerhq/react-native-hw-transport-ble` | 6.37.0 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ledgerhq/signer-utils` | 1.3.0 | missed-TP | not-in-DB | 5 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@levischuck/tiny-cbor` | 0.3.6 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/7715-permission-types` | 1.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/abi-utils` | 3.0.0 | missed-TP | not-in-DB | 80 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/account-api` | 2.0.0 | missed-TP | not-in-DB | 11 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/account-tree-controller` | 7.6.1 | missed-TP | not-in-DB | 31 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/accounts-controller` | 39.1.0 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/address-book-controller` | 7.1.2 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/ai-controllers` | 0.8.0 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/analytics-controller` | 2.0.0 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/api-specs` | 0.15.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/app-metadata-controller` | 2.0.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/approval-controller` | 9.0.2 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/assets-controller` | 13.1.2 | missed-TP | not-in-DB | 47 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/assets-controllers` | 111.1.1 | missed-TP | not-in-DB | 53 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/auth-network-utils` | 0.4.0 | missed-TP | not-in-DB | 18 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/authenticated-user-storage` | 3.0.1 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/base-controller` | 9.1.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/base-data-service` | 0.1.3 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/bridge-controller` | 79.2.0 | missed-TP | not-in-DB | 47 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/bridge-status-controller` | 75.1.0 | missed-TP | not-in-DB | 38 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/browser-passworder` | 6.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/chain-agnostic-permission` | 1.7.0 | missed-TP | not-in-DB | 15 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/chomp-api-service` | 4.0.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/claims-controller` | 0.6.0 | missed-TP | not-in-DB | 7 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/client-controller` | 1.0.1 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/client-utils` | 1.2.1 | missed-TP | not-in-DB | 9 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/compliance-controller` | 2.1.0 | missed-TP | not-in-DB | 5 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/config-registry-controller` | 2.0.1 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/connectivity-controller` | 0.3.0 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/contract-metadata` | 2.5.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/controller-utils` | 12.3.0 | missed-TP | not-in-DB | 22 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/core-backend` | 8.1.2 | missed-TP | not-in-DB | 20 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/delegation-controller` | 3.0.2 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/delegation-core` | 2.2.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/delegation-deployments` | 1.4.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/design-system-react-native` | 0.40.0 | missed-TP | not-in-DB | 203 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/design-system-shared` | 0.33.0 | missed-TP | not-in-DB | 70 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/design-system-twrnc-preset` | 0.9.0 | missed-TP | not-in-DB | 8 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/design-tokens` | 9.0.0 | missed-TP | not-in-DB | 28 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/earn-controller` | 12.1.0 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/eip-5792-middleware` | 3.0.4 | missed-TP | not-in-DB | 10 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/eip1193-permission-middleware` | 1.0.2 | missed-TP | not-in-DB | 5 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/eth-block-tracker` | 15.0.1 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/eth-hd-keyring` | 15.0.0 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/eth-json-rpc-filters` | 9.0.0 | missed-TP | not-in-DB | 9 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/eth-json-rpc-infura` | 10.3.0 | missed-TP | not-in-DB | 5 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/eth-json-rpc-middleware` | 23.1.3 | missed-TP | not-in-DB | 44 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/eth-json-rpc-provider` | 5.0.1 | missed-TP | not-in-DB | 7 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/eth-ledger-bridge-keyring` | 13.0.2 | missed-TP | not-in-DB | 17 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/eth-money-keyring` | 4.0.0 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/eth-qr-keyring` | 2.1.0 | missed-TP | not-in-DB | 7 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/eth-query` | 4.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/eth-sig-util` | 8.2.0 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/eth-simple-keyring` | 13.0.0 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/eth-snap-keyring` | 24.1.0 | missed-TP | not-in-DB | 16 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/etherscan-link` | 2.1.0 | missed-TP | not-in-DB | 7 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/ethjs-contract` | 0.4.1 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/ethjs-filter` | 0.3.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/ethjs-format` | 0.3.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/ethjs-query` | 0.7.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/ethjs-rpc` | 0.4.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/ethjs-unit` | 0.3.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/ethjs-util` | 0.3.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/gas-fee-controller` | 26.3.1 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/gator-permissions-controller` | 5.0.1 | missed-TP | not-in-DB | 14 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/geolocation-controller` | 1.0.0 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/hw-wallet-sdk` | 1.0.0 | missed-TP | not-in-DB | 7 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/json-rpc-engine` | 10.5.0 | missed-TP | not-in-DB | 20 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/json-rpc-middleware-stream` | 8.0.8 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/key-tree` | 10.1.1 | missed-TP | not-in-DB | 21 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/keyring-api` | 24.1.0 | missed-TP | not-in-DB | 51 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/keyring-controller` | 27.1.1 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/keyring-internal-api` | 12.1.0 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/keyring-internal-snap-client` | 11.1.0 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/keyring-sdk` | 3.1.0 | missed-TP | not-in-DB | 21 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/keyring-snap-client` | 10.0.0 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/keyring-snap-sdk` | 10.0.0 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/keyring-utils` | 5.0.0 | missed-TP | not-in-DB | 16 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/logging-controller` | 8.0.2 | missed-TP | not-in-DB | 10 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/messenger` | 2.0.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/metamask-eth-abis` | 3.1.1 | missed-TP | not-in-DB | 5 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/mobile-wallet-protocol-core` | 0.4.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/mobile-wallet-protocol-wallet-client` | 0.3.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/money-account-api-data-service` | 0.4.0 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/money-account-balance-service` | 2.4.0 | missed-TP | not-in-DB | 8 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/money-account-controller` | 1.0.0 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/money-account-upgrade-controller` | 3.0.0 | missed-TP | not-in-DB | 8 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/money-account-utils` | 1.0.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/multichain-account-service` | 13.0.2 | missed-TP | not-in-DB | 22 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/multichain-api-middleware` | 4.0.1 | missed-TP | not-in-DB | 10 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/multichain-network-controller` | 3.2.3 | missed-TP | not-in-DB | 7 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/multichain-transactions-controller` | 7.1.2 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/native-utils` | 0.8.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/network-controller` | 35.0.0 | missed-TP | not-in-DB | 11 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/network-enablement-controller` | 5.4.1 | missed-TP | not-in-DB | 7 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/nonce-tracker` | 6.0.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/notification-services-controller` | 26.0.0 | missed-TP | not-in-DB | 37 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/number-to-bn` | 1.7.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/object-multiplex` | 1.2.0 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/passkey-controller` | 3.0.0 | missed-TP | not-in-DB | 17 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/permission-controller` | 13.1.1 | missed-TP | not-in-DB | 9 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/perps-controller` | 11.0.0 | missed-TP | not-in-DB | 59 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/phishing-controller` | 17.3.1 | missed-TP | not-in-DB | 8 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/polling-controller` | 16.0.9 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/post-message-stream` | 10.0.0 | missed-TP | not-in-DB | 7 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/preferences-controller` | 23.1.0 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/profile-metrics-controller` | 4.0.3 | missed-TP | not-in-DB | 5 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/profile-sync-controller` | 29.0.0 | missed-TP | not-in-DB | 41 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/ramps-controller` | 20.0.0 | missed-TP | not-in-DB | 26 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/react-data-query` | 0.2.2 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/react-native-acm` | 1.2.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/react-native-actionsheet` | 2.4.2 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/react-native-button` | 3.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/react-native-payments` | 2.0.2 | missed-TP | not-in-DB | 9 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/react-native-search-api` | 1.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/react-native-webview` | 14.6.0 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | recovered by transub stack (db-growth + metamask-fp + transitive-subtract) |
| MetaMask | `@metamask/remote-feature-flag-controller` | 5.0.0 | missed-TP | not-in-DB | 7 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/rpc-errors` | 7.0.3 | missed-TP | not-in-DB | 5 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/safe-event-emitter` | 3.1.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/scure-bip39` | 2.1.1 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/sdk-analytics` | 0.0.5 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/sdk-communication-layer` | 0.33.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/seedless-onboarding-controller` | 10.1.1 | missed-TP | not-in-DB | 8 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/selected-network-controller` | 26.1.4 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/sentinel-api-service` | 1.0.0 | missed-TP | not-in-DB | 7 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/shield-controller` | 6.0.0 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/signature-controller` | 39.2.9 | missed-TP | not-in-DB | 8 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/smart-transactions-controller` | 25.0.0 | missed-TP | not-in-DB | 8 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/snap-account-service` | 2.1.2 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/snaps-controllers` | 21.1.0 | missed-TP | not-in-DB | 43 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/snaps-registry` | 4.0.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/snaps-rpc-methods` | 17.1.1 | missed-TP | not-in-DB | 73 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/snaps-sdk` | 12.0.0 | missed-TP | not-in-DB | 90 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/snaps-utils` | 12.5.0 | missed-TP | not-in-DB | 50 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/social-controllers` | 2.7.0 | missed-TP | not-in-DB | 5 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/stake-sdk` | 3.4.0 | missed-TP | not-in-DB | 30 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/storage-service` | 1.0.2 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/subscription-controller` | 7.0.0 | missed-TP | not-in-DB | 8 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/superstruct` | 3.4.1 | missed-TP | not-in-DB | 9 | out/tri1110.json; deps-rm/f-v4 listing | recovered by transub stack (db-growth + metamask-fp + transitive-subtract) |
| MetaMask | `@metamask/swappable-obj-proxy` | 2.3.0 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/toprf-secure-backup` | 1.1.0 | missed-TP | not-in-DB | 14 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/transaction-controller` | 69.5.1 | missed-TP | not-in-DB | 48 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/transaction-pay-controller` | 26.4.0 | missed-TP | not-in-DB | 66 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/utils` | 11.11.0 | missed-TP | not-in-DB | 108 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@metamask/wallet` | 10.0.0 | missed-TP | not-in-DB | 26 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@msgpack/msgpack` | 3.1.3 | missed-TP | not-in-DB | 32 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@native-html/css-processor` | 1.11.0 | missed-TP | not-in-DB | 36 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@native-html/transient-render-engine` | 11.2.3 | missed-TP | not-in-DB | 24 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ngraveio/bc-ur` | 1.1.13 | missed-TP | not-in-DB | 12 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@nktkas/hyperliquid` | 0.33.1 | missed-TP | not-in-DB | 201 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@nktkas/rews` | 4.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@noble/ciphers` | 1.3.0 | missed-TP | not-in-DB | 8 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@noble/curves` | 1.9.6 | missed-TP | not-in-DB | 119 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@noble/hashes` | 1.8.0 | missed-TP | not-in-DB | 61 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@open-rpc/meta-schema` | 1.14.9 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@open-rpc/schema-utils-js` | 2.1.2 | missed-TP | not-in-DB | 5 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@open-rpc/specification-extension-spec` | 1.0.2 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@react-native-cookies/cookies` | 6.2.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | recovered by transub stack (db-growth + metamask-fp + transitive-subtract) |
| MetaMask | `@react-native-firebase/messaging` | 20.5.0 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@react-native-masked-view/masked-view` | 0.3.2 | missed-TP | version-missing(at hbc96) | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@react-native/assets-registry` | 0.83.6 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@react-native/normalize-color` | 2.1.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@react-native/normalize-colors` | 0.83.6 | missed-TP | version-missing | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@react-navigation/bottom-tabs` | 6.6.1 | missed-TP | not-in-DB | 12 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@react-navigation/core` | 6.4.17 | missed-TP | no-HBC-build(hbc96) | 59 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@react-navigation/elements` | 1.3.31 | missed-TP | not-in-DB | 20 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@react-navigation/native-stack` | 6.11.0 | missed-TP | not-in-DB | 8 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@redux-saga/core` | 1.3.0 | missed-TP | not-in-DB | 5 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@redux-saga/deferred` | 1.2.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@redux-saga/delay-p` | 1.2.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@redux-saga/is` | 1.1.3 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@redux-saga/symbols` | 1.1.3 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@reown/walletkit` | 1.4.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@scure/base` | 1.2.6 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@scure/bip32` | 1.7.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@scure/bip39` | 1.6.0 | missed-TP | not-in-DB | 11 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@segment/sovran-react-native` | 1.1.3 | missed-TP | not-in-DB | 5 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@sentry-internal/browser-utils` | 10.37.0 | missed-TP | not-in-DB | 69 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@sentry-internal/feedback` | 10.37.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@sentry-internal/replay` | 10.37.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@sentry-internal/replay-canvas` | 10.37.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@sentry/browser` | 10.37.0 | missed-TP | not-in-DB | 80 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@sentry/core` | 10.37.0 | missed-TP | not-in-DB | 310 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@sentry/react` | 10.37.0 | missed-TP | not-in-DB | 17 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@socket.io/component-emitter` | 3.1.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@solana/addresses` | 2.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@solana/assertions` | 2.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@solana/codecs-core` | 2.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@solana/codecs-strings` | 2.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@solana/errors` | 2.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@spruceid/siwe-parser` | 2.1.0 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@stablelib/binary` | 1.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@stablelib/int` | 1.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@stablelib/random` | 1.0.2 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@stablelib/wipe` | 1.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@tanstack/query-core` | 4.43.0 | missed-TP | version-missing | 66 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@tanstack/react-query` | 4.43.0 | missed-TP | version-missing | 24 | out/tri1110.json; deps-rm/f-v4 listing | recovered by transub stack (db-growth + metamask-fp + transitive-subtract) |
| MetaMask | `@tommasini/react-native-scrollable-tab-view` | 1.1.1 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@toruslabs/constants` | 15.0.0 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@toruslabs/eccrypto` | 6.2.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@toruslabs/fetch-node-details` | 15.0.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@toruslabs/fnd-base` | 15.0.0 | missed-TP | not-in-DB | 5 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@toruslabs/http-helpers` | 8.1.1 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@tradle/react-native-http` | 2.0.1 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@ungap/structured-clone` | 1.3.0 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@veriff/react-native-sdk` | 11.2.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@walletconnect/core` | 2.23.4 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@walletconnect/environment` | 1.0.1 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@walletconnect/events` | 1.0.1 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@walletconnect/heartbeat` | 1.2.2 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@walletconnect/jsonrpc-provider` | 1.0.14 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@walletconnect/jsonrpc-types` | 1.0.4 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@walletconnect/jsonrpc-utils` | 1.0.8 | missed-TP | not-in-DB | 9 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@walletconnect/jsonrpc-ws-connection` | 1.0.16 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@walletconnect/keyvaluestorage` | 1.1.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@walletconnect/logger` | 3.0.2 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@walletconnect/react-native-compat` | 2.23.4 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@walletconnect/relay-api` | 1.0.11 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@walletconnect/relay-auth` | 1.1.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@walletconnect/safe-json` | 1.0.2 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@walletconnect/sign-client` | 2.23.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@walletconnect/time` | 1.0.2 | missed-TP | not-in-DB | 10 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@walletconnect/types` | 2.23.4 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@walletconnect/utils` | 2.23.4 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@walletconnect/window-getters` | 1.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@walletconnect/window-metadata` | 1.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@welldone-software/why-did-you-render` | 8.0.3 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@xmldom/xmldom` | 0.8.13 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@xstate/fsm` | 2.1.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `Base64` | 0.2.1 | missed-TP | version-missing | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `abitype` | 1.2.3 | missed-TP | unknown(below-bar/not-proposed) | 66 | out/tri1110.json; deps-rm/f-v4 listing | none |
| MetaMask | `aes-js` | 3.0.0 | missed-TP | not-in-DB | 20 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `ajv` | 6.12.6 | missed-TP | version-missing | 40 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `ansi-styles` | 4.3.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `apg-js` | 4.4.0 | missed-TP | not-in-DB | 24 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `asn1.js` | 4.10.1 | missed-TP | version-missing | 14 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `async-function` | 1.0.0 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `async-generator-function` | 1.0.0 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `available-typed-arrays` | 1.0.7 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `base-x` | 3.0.11 | missed-TP | tiny | 2 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `base64-js` | 1.5.1 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `bech32` | 2.0.0 | missed-TP | version-missing(at hbc96) | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `bitcoin-address-validation` | 2.2.3 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `bn.js` | 4.12.3 | missed-TP | not-in-DB | 11 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `bnjs4` | 4.12.3 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `boolbase` | 1.0.0 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `brorand` | 1.1.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `browserify-aes` | 1.2.0 | missed-TP | not-in-DB | 16 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `browserify-cipher` | 1.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `browserify-des` | 1.0.2 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `browserify-rsa` | 4.1.0 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `browserify-sign` | 4.2.3 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `browserify-zlib` | 0.2.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `bs58check` | 2.1.2 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `buffer` | 5.7.1 | missed-TP | tiny | 9 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `buffer-xor` | 1.0.3 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `builtins` | 5.0.1 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `call-bind` | 1.0.8 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `call-bind-apply-helpers` | 1.0.2 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `call-bound` | 1.0.4 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `camelize` | 1.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `cbor-sync` | 1.0.4 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `centrifuge` | 5.4.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `chalk` | 4.1.2 | missed-TP | no-HBC-build(hbc96) | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `cids` | 0.7.5 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `cipher-base` | 1.0.7 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `class-is` | 1.1.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `color-convert` | 1.9.3 | missed-TP | version-missing | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `color-name` | 1.1.3 | missed-TP | version-missing | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `compare-versions` | 3.6.0 | missed-TP | version-missing | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `compression-streams-polyfill` | 0.1.7 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `concat-stream` | 2.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `content-hash` | 2.5.2 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `core-util-is` | 1.0.3 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `crc` | 3.8.0 | missed-TP | not-in-DB | 25 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `create-hash` | 1.2.0 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `create-hmac` | 1.1.7 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `create-react-class` | 15.7.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `crypto-js` | 4.2.0 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `css-color-keywords` | 1.0.0 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `d3-array` | 1.2.4 | missed-TP | version-missing | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `d3-format` | 1.4.5 | missed-TP | version-missing | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `d3-interpolate-path` | 2.0.0 | missed-TP | version-missing | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `debug` | 4.4.3 | missed-TP | not-in-DB | 10 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `deep-freeze-strict` | 1.1.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `define-data-property` | 1.1.4 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `des.js` | 1.0.1 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `detect-browser` | 5.3.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `dijkstrajs` | 1.0.2 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `dom-serializer` | 2.0.0 | missed-TP | unknown(below-bar/not-proposed) | 4 | out/tri1110.json; deps-rm/f-v4 listing | none |
| MetaMask | `domelementtype` | 2.3.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `domutils` | 3.2.2 | missed-TP | not-in-DB | 16 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `dunder-proto` | 1.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `eciesjs` | 0.4.17 | missed-TP | no-HBC-build(hbc96) | 11 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `elliptic` | 6.6.1 | missed-TP | not-in-DB | 15 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `entities` | 4.5.0 | missed-TP | not-in-DB | 16 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `es-errors` | 1.3.0 | missed-TP | not-in-DB | 7 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `es-object-atoms` | 1.1.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `es6-error` | 4.1.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `escape-string-regexp` | 4.0.0 | missed-TP | version-missing | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `eth-ens-namehash` | 2.0.8 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `eth-method-registry` | 4.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `eth-url-parser` | 1.0.4 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `ethereum-cryptography` | 2.2.1 | missed-TP | not-in-DB | 22 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `ethereum-ens-network-map` | 1.0.2 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `ethereumjs-abi` | 0.6.8 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `ethereumjs-util` | 7.1.5 | missed-TP | not-in-DB | 22 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `ethereumjs-wallet` | 1.0.2 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `ethers` | 5.7.2 | missed-TP | not-in-DB | 240 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `ethjs-abi` | 0.2.1 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `ethjs-contract` | 0.1.9 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `ethjs-ens` | 2.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `ethjs-filter` | 0.1.5 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `ethjs-format` | 0.2.2 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `ethjs-query` | 0.2.9 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `ethjs-rpc` | 0.1.5 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `ethjs-util` | 0.1.6 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `event-target-shim` | 5.0.1 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `eventemitter2` | 6.4.9 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `events-universal` | 1.0.1 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `evp_bytestokey` | 1.0.3 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `expo-apple-authentication` | 55.0.13 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `expo-application` | 55.0.15 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `expo-asset` | 55.0.17 | missed-TP | not-in-DB | 12 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `expo-auth-session` | 55.0.16 | missed-TP | not-in-DB | 14 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `expo-constants` | 55.0.16 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `expo-crypto` | 55.0.15 | missed-TP | not-in-DB | 7 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `expo-file-system` | 55.0.22 | missed-TP | not-in-DB | 5 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `expo-haptics` | 55.0.14 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `expo-image` | 55.0.11 | missed-TP | not-in-DB | 10 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `expo-linking` | 55.0.15 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `expo-local-authentication` | 55.0.14 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `expo-screen-orientation` | 55.0.16 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `expo-sensors` | 55.0.15 | missed-TP | not-in-DB | 18 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `expo-splash-screen` | 55.0.21 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `expo-updates` | 55.0.24 | missed-TP | not-in-DB | 8 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `expo-web-browser` | 55.0.16 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `fast-base64-decode` | 1.0.0 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `fast-deep-equal` | 3.1.3 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `fast-fifo` | 1.3.2 | missed-TP | tiny | 2 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `fast-json-stable-stringify` | 2.1.0 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `fast-safe-stringify` | 2.1.1 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `filter-obj` | 1.1.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `for-each` | 0.3.5 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `function-bind` | 1.1.2 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `fuse.js` | 3.4.4 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `generator-function` | 2.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `get-intrinsic` | 1.3.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `get-proto` | 1.0.1 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `gopd` | 1.2.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `has-property-descriptors` | 1.0.2 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `has-symbols` | 1.1.0 | missed-TP | ambiguity | 2 | out/tri1110.json; deps-rm/f-v4 listing | deps-ambiguity-cutoff |
| MetaMask | `has-tostringtag` | 1.0.2 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `hash-base` | 3.1.0 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `hash.js` | 1.1.7 | missed-TP | not-in-DB | 12 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `hasown` | 2.0.4 | missed-TP | ambiguity | 1 | out/tri1110.json; deps-rm/f-v4 listing | deps-ambiguity-cutoff |
| MetaMask | `hdkey` | 2.1.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `he` | 1.2.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `hmac-drbg` | 1.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `htmlparser2` | 7.2.0 | missed-TP | version-missing | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `https-browserify` | 0.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `humanize-duration` | 3.27.3 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `i18n-js` | 3.0.11 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `idna-uts46` | 1.1.0 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `idna-uts46-hx` | 2.3.1 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `inherits` | 2.0.4 | missed-TP | version-missing(at hbc96) | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `invariant` | 2.2.4 | missed-TP | version-missing(at hbc96) | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `inversify` | 7.5.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `ip-regex` | 5.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `is-arguments` | 1.1.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `is-arrayish` | 0.3.2 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `is-callable` | 1.2.7 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `is-fn` | 1.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `is-hex-prefixed` | 1.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `is-nan` | 1.3.2 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `is-url` | 1.2.4 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `isarray` | 1.0.0 | missed-TP | version-missing | 5 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `isows` | 1.0.7 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `js-sha3` | 0.9.3 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `json-rpc-random-id` | 1.0.1 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `json-schema-traverse` | 0.4.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `json-stable-stringify-without-jsonify` | 1.0.1 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `keccak` | 3.0.4 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `marked` | 12.0.2 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `math-intrinsics` | 1.1.0 | missed-TP | not-in-DB | 8 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `md5.js` | 1.3.5 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `memoize-one` | 5.2.1 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `mersenne-twister` | 1.1.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `metro-runtime` | 0.83.7 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `micro-ftch` | 0.3.1 | missed-TP | version-missing | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `miller-rabin` | 4.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `minimalistic-assert` | 1.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `ms` | 2.1.3 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `multibase` | 0.6.1 | missed-TP | not-in-DB | 18 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `multicodec` | 1.0.4 | missed-TP | not-in-DB | 12 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `multiformats` | 9.9.0 | missed-TP | not-in-DB | 24 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `multihashes` | 0.4.21 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `nullthrows` | 1.1.1 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `number-to-bn` | 1.7.0 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `object-assign` | 4.1.1 | missed-TP | version-missing(at hbc96) | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `object-inspect` | 1.13.4 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `object-is` | 1.1.5 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `object.assign` | 4.1.7 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `once` | 1.4.0 | missed-TP | version-missing(at hbc96) | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `openapi-fetch` | 0.13.7 | missed-TP | version-missing | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `ox` | 0.9.3 | missed-TP | not-in-DB | 109 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `p-limit` | 3.1.0 | missed-TP | version-missing | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `pako` | 1.0.11 | missed-TP | not-in-DB | 27 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `parse-asn1` | 5.1.7 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `pbkdf2` | 3.1.3 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `picocolors` | 1.1.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `pify` | 5.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `pino` | 10.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `pony-cause` | 2.1.11 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `possible-typed-array-names` | 1.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `process-nextick-args` | 2.0.1 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `promise-to-callback` | 1.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `prop-types` | 15.7.2 | missed-TP | unknown(below-bar/not-proposed) | 30 | out/tri1110.json; deps-rm/f-v4 listing | none |
| MetaMask | `public-encrypt` | 4.0.3 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `pump` | 3.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `punycode` | 2.3.1 | missed-TP | version-missing(at hbc96) | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `purify-ts` | 2.1.0 | missed-TP | not-in-DB | 10 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `querystring` | 0.2.0 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `quick-format-unescaped` | 4.0.4 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `randombytes` | 2.1.0 | missed-TP | version-missing(at hbc96) | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `randomfill` | 1.0.4 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `react-freeze` | 1.0.4 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `react-native-branch` | 5.6.2 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `react-native-browser-polyfill` | 0.1.2 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `react-native-confirmation-code-field` | 7.6.1 | missed-TP | not-in-DB | 10 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `react-native-crypto` | 2.2.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `react-native-default-preference` | 1.4.3 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `react-native-elevated-view` | 0.0.6 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `react-native-fade-in-image` | 1.4.1 | missed-TP | not-in-DB | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `react-native-fast-crypto` | 2.2.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `react-native-get-random-values` | 2.0.0 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `react-native-gzip` | 1.1.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `react-native-i18n` | 2.0.15 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `react-native-in-app-review` | 4.3.3 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `react-native-iphone-x-helper` | 1.3.1 | missed-TP | version-missing(at hbc96) | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `react-native-is-edge-to-edge` | 1.2.1 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `react-native-jazzicon` | 0.1.2 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `react-native-keyboard-controller` | 1.20.7 | missed-TP | not-in-DB | 42 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `react-native-keychain` | 9.2.3 | missed-TP | version-missing | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `react-native-launch-arguments` | 4.0.1 | missed-TP | version-missing | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `react-native-linear-gradient` | 2.8.3 | missed-TP | unknown(below-bar/not-proposed) | 5 | out/tri1110.json; deps-rm/f-v4 listing | none |
| MetaMask | `react-native-mmkv` | 3.3.3 | missed-TP | no-HBC-build(hbc96) | 11 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `react-native-nitro-fetch` | 1.3.3 | missed-TP | not-in-DB | 11 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `react-native-nitro-text-decoder` | 0.2.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `react-native-nitro-websockets` | 1.0.3 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `react-native-performance` | 6.0.0 | missed-TP | not-in-DB | 8 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `react-native-progress` | 3.5.0 | missed-TP | version-missing | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `react-native-qrcode-svg` | 6.3.21 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `react-native-quick-base64` | 2.2.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `react-native-quick-crypto` | 0.7.15 | missed-TP | no-HBC-build(hbc96) | 22 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `react-native-release-profiler` | 0.4.4 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `react-native-reorderable-list` | 0.18.1 | missed-TP | not-in-DB | 25 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `react-native-sensors` | 5.3.0 | missed-TP | not-in-DB | 3 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `react-native-skeleton-placeholder` | 5.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `react-native-step-indicator` | 1.0.3 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `react-native-svg-charts` | 5.4.0 | missed-TP | not-in-DB | 24 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `react-native-url-polyfill` | 2.0.0 | missed-TP | version-missing(at hbc96) | 8 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `react-timer-mixin` | 0.13.4 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `redux-devtools-expo-dev-plugin` | 1.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `redux-persist` | 6.0.0 | missed-TP | not-in-DB | 13 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `redux-persist-filesystem-storage` | 4.2.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `requires-port` | 1.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `ripemd160` | 2.0.2 | missed-TP | version-missing | 2 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `rive-react-native` | 9.8.5 | missed-TP | not-in-DB | 5 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `rlp` | 2.2.7 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `safe-buffer` | 5.2.1 | missed-TP | version-missing(at hbc96) | 5 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `safe-stable-stringify` | 2.5.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `scrypt-js` | 3.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `semver` | 7.8.5 | missed-TP | not-in-DB | 136 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `set-function-length` | 1.2.2 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `set-immediate-shim` | 1.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `side-channel` | 1.1.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `side-channel-list` | 1.0.0 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `side-channel-map` | 1.0.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `side-channel-weakmap` | 1.0.2 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `simple-swizzle` | 0.2.2 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `single-call-balance-checker-abi` | 1.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `siwe` | 2.3.2 | missed-TP | not-in-DB | 5 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `sjcl` | 1.0.8 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `source-map` | 0.6.1 | missed-TP | not-in-DB | 6 | out/tri1110.json; deps-rm/f-v4 listing | recovered by transub stack (db-growth + metamask-fp + transitive-subtract) |
| MetaMask | `split-on-first` | 1.1.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `stream-browserify` | 3.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `streamx` | 2.23.0 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `strict-uri-encode` | 2.0.0 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `string_decoder` | 1.3.0 | missed-TP | tiny | 4 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `stringify-entities` | 3.1.0 | missed-TP | not-in-DB | 12 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `strip-hex-prefix` | 1.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `supports-color` | 7.2.0 | missed-TP | no-HBC-build(hbc96) | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `tailwindcss` | 3.4.17 | missed-TP | not-in-DB | 26 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `text-decoder` | 1.2.3 | missed-TP | tiny | 3 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `through2` | 3.0.1 | missed-TP | version-missing | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `to-buffer` | 1.2.2 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `tweetnacl` | 1.0.3 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `uint8arrays` | 3.1.1 | missed-TP | not-in-DB | 10 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `ulid` | 2.3.0 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `unicode-confusables` | 0.1.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `urijs` | 1.19.11 | missed-TP | not-in-DB | 4 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `use-latest-callback` | 0.2.6 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `use-sync-external-store` | 1.6.0 | missed-TP | unknown(below-bar/not-proposed) | 4 | out/tri1110.json; deps-rm/f-v4 listing | none |
| MetaMask | `utf8` | 3.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `util-deprecate` | 1.0.2 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `uuid` | 8.3.2 | missed-TP | version-missing | 543 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `valibot` | 1.4.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `validate-npm-package-name` | 5.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `warn-once` | 0.1.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `webidl-conversions` | 5.0.0 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `whatwg-url-without-unicode` | 8.0.0-3 | missed-TP | not-in-DB | 10 | out/tri1110.json; deps-rm/f-v4 listing | recovered by transub stack (db-growth + metamask-fp + transitive-subtract) |
| MetaMask | `wrappy` | 1.0.2 | missed-TP | tiny | 1 | out/tri1110.json; out/tiny-mm.txt | none |
| MetaMask | `ws` | 7.5.10 | missed-TP | version-missing | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `xhr2` | 0.2.1 | missed-TP | not-in-DB | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `xtend` | 4.0.2 | missed-TP | version-missing(at hbc96) | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `yocto-queue` | 0.1.0 | missed-TP | version-missing | 1 | out/tri1110.json; deps-rm/f-v4 listing | none (DB wishlist) |
| MetaMask | `@react-native-community/cookies` | ? | FP (base only) | copies (fork/rename of @react-native-cookies/cookies) |  | deps-mm-fp-dumps/mm.dump.json | transub stack (db-growth + metamask-fp + transitive-subtract) |
| MetaMask | `@shopify/react-native-skia` | 2.11.1 | FP (both) | copies (hits in react-native-reanimated); owners: react-native-reanimated 77, <app> 62, react-native-vision-camera 46, expo-auth-session 17 |  | deps-mm-fp-dumps/mm.dump.json | none |
| MetaMask | `fast-json-patch` | 2.1.0 | FP (both) | copies (hits in object-keys); owners: object-keys 8, function-bind 7, call-bind-apply-helpers 5, get-proto 5 |  | deps-mm-fp-dumps/mm.dump.json | none |
| MetaMask | `fast-xml-builder` | 1.3.1 | FP (base only) | copies (hits in fast-xml-parser); owners: fast-xml-parser 36, fuse.js 1 |  | deps-mm-fp-dumps/mm.dump.json | transub stack (db-growth + metamask-fp + transitive-subtract) |
| MetaMask | `is-array-buffer` | 3.0.5 | FP (base only) | copies (hits in function-bind); owners: function-bind 7, call-bind-apply-helpers 6, get-proto 5, has-symbols 3 |  | deps-mm-fp-dumps/mm.dump.json | transub stack (db-growth + metamask-fp + transitive-subtract) |
| MetaMask | `is-regex` | 1.1.4 | FP (both) | copies (hits in function-bind); owners: function-bind 7, call-bind-apply-helpers 6, get-proto 5, has-symbols 3 |  | deps-mm-fp-dumps/mm.dump.json | none |
| MetaMask | `jszip` | 3.9.0 | FP (both) | copies (hits in pako); owners: pako 29, ethers 2, @tradle/react-native-http 1, set-immediate-shim 1 |  | deps-mm-fp-dumps/mm.dump.json | none |
| MetaMask | `mammoth` | 1.9.0 | FP (both) | copies (hits in @xmldom/xmldom); owners: @xmldom/xmldom 84, <app> 3, ? 1, sjcl 1 |  | deps-mm-fp-dumps/mm.dump.json | none |
| MetaMask | `p-map` | 7.0.7 | FP (both) | copies (hits in @babel/runtime); owners: @babel/runtime 7 |  | deps-mm-fp-dumps/mm.dump.json | none |
| MetaMask | `react-native-webview` | ? | FP (base only) | copies (fork/rename of @metamask/react-native-webview) |  | deps-mm-fp-dumps/mm.dump.json | transub stack (db-growth + metamask-fp + transitive-subtract) |
| MetaMask | `react-query` | 4.0.0 | FP (base only) | copies (fork/rename of @tanstack/react-query); owners: @tanstack/query-core 95, @tanstack/react-query 2 |  | deps-mm-fp-dumps/mm.dump.json | transub stack (db-growth + metamask-fp + transitive-subtract) |
| MetaMask | `react-reconciler` | 0.33.0 | FP (both) | copies (hits in react-native); owners: react-native 58 |  | deps-mm-fp-dumps/mm.dump.json | none |
| MetaMask | `reactotron-react-native` | 5.0.3 | FP (both) | copies (hits in @babel/runtime); owners: @babel/runtime 34, query-string 8, decode-uri-component 5, redux-persist 3 |  | deps-mm-fp-dumps/mm.dump.json | none |
| MetaMask | `resq` | 1.9.2 | FP (both) | copies (hits in fuse.js); owners: fuse.js 5, fast-xml-parser 1, assert 1 |  | deps-mm-fp-dumps/mm.dump.json | none |
| MetaMask | `rpc-websockets` | 7.9.0 | FP (both) | copies (hits in @babel/runtime); owners: @babel/runtime 34, eventemitter3 12, assert 2, react-native-reanimated 1 |  | deps-mm-fp-dumps/mm.dump.json | none |
| MetaMask | `source-map-js` | 1.2.1 | FP (base only) | copies (fork/rename of source-map); owners: source-map 38 |  | deps-mm-fp-dumps/mm.dump.json | transub stack (db-growth + metamask-fp + transitive-subtract) |
| MetaMask | `superstruct` | 2.0.2 | FP (base only) | copies (fork/rename of @metamask/superstruct); owners: @metamask/superstruct 29, @metamask/snaps-utils 1 |  | deps-mm-fp-dumps/mm.dump.json | transub stack (db-growth + metamask-fp + transitive-subtract) |
| MetaMask | `typeorm` | 0.3.31 | FP (both) | truth-noise? (hits mostly in app-owned modules); owners: <app> 153, react-native-vision-camera 24, ms 8, react-native 6 |  | deps-mm-fp-dumps/mm.dump.json | none |
| MetaMask | `wagmi` | 1.4.12 | FP (both) | copies (hits in viem); owners: viem 244, @tanstack/query-core 182, @tanstack/react-query 64, <app> 22 |  | deps-mm-fp-dumps/mm.dump.json | none |
| MetaMask | `whatwg-url` | 15.1.0 | FP (base only) | copies (fork/rename of whatwg-url-without-unicode); owners: whatwg-url-without-unicode 26, whatwg-url-minimum 3, <app> 1 |  | deps-mm-fp-dumps/mm.dump.json | transub stack (db-growth + metamask-fp + transitive-subtract) |
| react-navigation | `@react-native/normalize-colors` | ? | TP lost by transub stack | closure subtraction / copies (confirmed at base, gone after) |  | deps-transub-meas/out/after-nav.json | none: regression to fix before the transub stack lands |
| bluesky | `@react-native/normalize-colors` | ? | TP lost by transub stack | closure subtraction / copies (confirmed at base, gone after) |  | deps-transub-meas/out/after-bsky.json | none: regression to fix before the transub stack lands |
| bluesky | `react-native-gesture-handler` | ? | TP lost by transub stack | closure subtraction / copies (confirmed at base, gone after) |  | deps-transub-meas/out/after-bsky.json | none: regression to fix before the transub stack lands |
| bluesky | `react-native-svg` | ? | TP lost by transub stack | closure subtraction / copies (confirmed at base, gone after) |  | deps-transub-meas/out/after-bsky.json | deps-ambiguity-cutoff (react-native-svg dist-carrier guard f328d4d) |
| rainbow | `base-64` | ? | TP lost by transub stack | closure subtraction / copies (confirmed at base, gone after) |  | deps-transub-meas/out/after-rain.json | none: regression to fix before the transub stack lands |
| MetaMask | `base-64` | ? | TP lost by transub stack | closure subtraction / copies (confirmed at base, gone after) |  | deps-transub-meas/out/after-mm.json | none: regression to fix before the transub stack lands |
| MetaMask | `klona` | ? | TP lost by transub stack | closure subtraction / copies (confirmed at base, gone after) |  | deps-transub-meas/out/after-mm.json | none: regression to fix before the transub stack lands |
| MetaMask | `readable-web-to-node-stream` | ? | TP lost by transub stack | closure subtraction / copies (confirmed at base, gone after) |  | deps-transub-meas/out/after-mm.json | none: regression to fix before the transub stack lands |
| MetaMask | `valid-url` | ? | TP lost by transub stack | closure subtraction / copies (confirmed at base, gone after) |  | deps-transub-meas/out/after-mm.json | none: regression to fix before the transub stack lands |
