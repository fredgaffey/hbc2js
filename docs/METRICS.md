# Metrics

Real-world `hbc2js deps` measurements. Controlled-fixture numbers live in
`docs/DEPS.md` (Ground truth, D17d); this file is the corpus layer.

## Measurement 2026-11-09 (main c92c9e4, db-v3-clean, offline)

- `hbc2js` measured at commit `c92c9e4`, `deps --offline` only (no `--confirm`).
- Signature DB: db-v3-clean (71,222 signature files, read-only, nothing written back).
- Three runs in parallel on a 32-core host. Bundle shapes: 22 bundle-bearing apps; every row below is a count.
- "before" is the section further down (commit `ce7acd8`).

### Per-app counts, before and after (offline)

| app | HBC | modules before | modules now | confirmed before | confirmed now | unique before | unique now | guessed before | guessed now | wall before | wall now |
|---|---|---|---|---|---|---|---|---|---|---|---|
| app.phantom | 96 | 19,265 | 19,265 | 365 | 310 | 119 | 106 | 23 | 18 | 42 s | 49 s |
| com.baronapp.cameo | 96 | 11,174 | 11,174 | 281 | 298 | 92 | 102 | 24 | 12 | 31 s | 36 s |
| com.bloomberg.android.plus | 96 | 4,995 | 4,995 | 283 | 241 | 89 | 78 | 11 | 6 | 26 s | 28 s |
| com.brex.mobile | 98 | 15,014 | out of memory | 256 | n/a | 83 | n/a | 25 | n/a | 30 s | n/a |
| com.discord | 98 | 17,037 | 17,037 | 271 | 222 | 90 | 77 | 18 | 10 | 33 s | 40 s |
| com.microsoft.office.officehubrow | 96 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 s | 1 s |
| com.microsoft.teams | 96 | 482 | 482 | 31 | 30 | 9 | 8 | 0 | 1 | 8 s | 8 s |
| com.microsoft.xboxone.smartglass | 96 | 6,435 | 6,435 | 315 | 259 | 104 | 90 | 6 | 6 | 23 s | 30 s |
| com.myklarnamobile | 98 | 0 | 23,651 | 0 | 51 | 0 | 17 | 0 | 6 | 14 s | 69 s |
| com.oculus.twilight | 99 | 13,978 | 13,978 | 40 | 40 | 14 | 12 | 4 | 2 | 25 s | 30 s |
| com.scee.psxandroid | 96 | 7,657 | 7,657 | 221 | 170 | 73 | 55 | 17 | 6 | 22 s | 28 s |
| com.shopify.arrive | 96 | 9,461 | 9,461 | 251 | 221 | 80 | 75 | 22 | 9 | 27 s | 33 s |
| com.shopify.mobile | 98 | 25,439 | 25,439 | 258 | 258 | 87 | 86 | 9 | 6 | 34 s | 41 s |
| com.shopify.ping | 96 | 8,651 | 8,651 | 205 | 163 | 65 | 49 | 15 | 7 | 22 s | 25 s |
| com.teslamotors.tesla | 96 | 19,951 | 19,951 | 432 | 403 | 141 | 139 | 28 | 12 | 50 s | 84 s |
| com.uniswap.mobile | 98 | 11,380 | 11,380 | 360 | 365 | 123 | 107 | 17 | 10 | 37 s | 42 s |
| com.wix.android | 96 | 19,286 | 19,286 | 474 | 433 | 160 | 153 | 33 | 17 | 46 s | 56 s |
| host.exp.exponent | 96 | 2,370 | 2,370 | 87 | 79 | 29 | 27 | 9 | 6 | 13 s | 15 s |
| io.metamask | 96 | 18,909 | 18,909 | 482 | 434 | 156 | 147 | 34 | 21 | 46 s | 61 s |
| me.rainbow | 96 | 10,307 | 10,307 | 396 | 297 | 121 | 100 | 30 | 14 | 33 s | 38 s |
| org.toshi | 96 | 31,131 | 31,131 | 443 | 369 | 142 | 126 | 31 | 12 | 53 s | 69 s |
| xyz.blueskyweb.app | 98 | 6,392 | 6,392 | 117 | 119 | 39 | 39 | 10 | 11 | 25 s | 29 s |

### Aggregate

| metric | before | now |
|---|---|---|
| apps with a module inventory | 20 | 21 listed, 20 measured (1 out of memory) |
| confirmed, 19 apps comparable in both runs (excl. the out-of-memory app and the newly inventoried app) | 5,312 | 4,711 |
| guessed, same 19 apps | 341 | 186 |
| confirmed, sum over the 20 measured apps | 5,568 (incl. the out-of-memory app, 256) | 4,762 |
| guessed, sum over the 20 measured apps | 366 (incl. the out-of-memory app, 25) | 192 |
| wall per measured app | about 31 s | about 41 s (811 s over 20 apps) |

- Newly inventoried: 1 app went from 0 to 23,651 modules (51 confirmed, 17 unique, 6 guessed). 1 app still reports 0 modules.
- 1 app (15,014 modules before) exhausts the Node heap at 8 GB during candidate derivation: about 10,000 signature files read and retained, mostly `@aws-sdk/*` and `@aws-amplify/*` versions, none of it released. No result.
- Confirmed counts fell on 14 of 19 comparable apps (generic-copy hashes and dep-flagged module hits no longer count), guessed counts fell on 16.

### Ground-truth apps (offline, db-v3-clean)

Precision and recall against the lockfile truth; `direct` recall is over direct dependencies.

| app | truth packages (direct) | before: confirmed / precision / recall | now: confirmed / precision / recall | now: recall of direct | now: guessed / precision |
|---|---|---|---|---|---|
| bluesky-social/social-app | 198 (198) | 47 / 63.8% / 15.2% | 51 / 68.6% / 17.7% | 17.7% | 12 / 91.7% |
| rainbow-me/rainbow | 518 (211) | 141 / 60.3% / 16.4% | 116 / 72.4% / 16.2% | 21.3% | 11 / 54.5% |
| MetaMask/metamask-mobile | 749 (306) | 186 / 67.7% / 16.8% | 183 / 74.3% / 18.2% | 21.9% | 15 / 66.7% |
| Expensify/App 12a92bd | 288 (91) | 135 / 65.9% / 30.9% | 154 / 59.1% / 31.6% | 35.2% | 5 / 20.0% |
| react-navigation-example 0.85.3 | 76 (61) | 14 / 100% / 18.4% | 14 / 100% / 18.4% | 23.0% | 7 / 100% |

### Precision proxy (sample of confirmed packages)

Ten packages per app, drawn with the fixed seed, judged by string evidence in the bundle and APK file names. The sample for one of the three apps could not be drawn (no result, see above).

| apps sampled | packages | string evidence in bundle or APK | generic word | no evidence found |
|---|---|---|---|---|
| 2 (phantom, cameo) | 20 | 14 | 1 | 5 |
| before: 3 apps | 30 | 16 | 11 | 3 |

## Previous measurement (commit `ce7acd8`)

- Signature DB: db-v3 (71,222 signature files, the pristine file set; copies were used for every run, nothing was written back). Offline match + guess for the per-app table; `--confirm` for the confirm tables below.
- `hbc2js` measured at commit `ce7acd84840093c037e6447c12aaf112643ce461`.
- Corpus: 27 published Android APKs. Package names are not listed in the per-app tables: counts only.

## Coverage

| | apps |
|---|---|
| Corpus | 27 |
| Hermes bundle found and read | 22 |
| No Hermes bundle in the APK (no `libhermes.so`; not React Native with Hermes) | 5 |
| Of the 22: real module inventory | 20 |
| Of the 22: `totalModules: 0` (webpack/multi-bundle shapes, docs/BUGS.md `corpus-B4`) | 2 |

HBC versions among the 22 bundles: 96 (15 apps), 98 (6), 99 (1).

## Per-app counts (offline, all 22 bundles)

`confirmed` and `guessed` are dependency entries (one per package version); `unique` is the number of distinct confirmed packages. `bundle file` is the APK entry the bundle was read from. Wall time is per app with four runs in parallel on a 32-core host.

| app | HBC | modules | functions | confirmed | unique | guessed | wall | bundle file |
|---|---|---|---|---|---|---|---|---|
| app.phantom | 96 | 19,265 | 208,026 | 365 | 119 | 23 | 42 s | `assets/index.android.bundle` |
| com.baronapp.cameo | 96 | 11,174 | 60,154 | 281 | 92 | 24 | 31 s | `assets/index.android.bundle` |
| com.bloomberg.android.plus | 96 | 4,995 | 58,932 | 283 | 89 | 11 | 26 s | `assets/index.android.bundle` |
| com.brex.mobile | 98 | 15,014 | 109,505 | 256 | 83 | 25 | 30 s | `assets/index.android.bundle` |
| com.discord | 98 | 17,037 | 120,522 | 271 | 90 | 18 | 33 s | `assets/index.android.bundle` |
| com.microsoft.office.officehubrow | 96 | 0 | 9,491 | 0 | 0 | 0 | 1 s | `assets/LivePersonaCard.bundle` |
| com.microsoft.teams | 96 | 482 | 4,736 | 31 | 9 | 0 | 8 s | `assets/app_packages/teams-rn-common/hermes.android.bundle` |
| com.microsoft.xboxone.smartglass | 96 | 6,435 | 59,278 | 315 | 104 | 6 | 23 s | `assets/index.android.bundle` |
| com.myklarnamobile | 98 | 0 | 82,098 | 0 | 0 | 0 | 14 s | `assets/index.android.bundle` |
| com.oculus.twilight | 99 | 13,978 | 82,047 | 40 | 14 | 4 | 25 s | `assets/index.android.bundle` |
| com.scee.psxandroid | 96 | 7,657 | 65,991 | 221 | 73 | 17 | 22 s | `assets/index.android.bundle` |
| com.shopify.arrive | 96 | 9,461 | 69,138 | 251 | 80 | 22 | 27 s | `assets/index.android.bundle` |
| com.shopify.mobile | 98 | 25,439 | 97,752 | 258 | 87 | 9 | 34 s | `assets/index.android.bundle` |
| com.shopify.ping | 96 | 8,651 | 52,278 | 205 | 65 | 15 | 22 s | `assets/index.android.bundle` |
| com.teslamotors.tesla | 96 | 19,951 | 210,694 | 432 | 141 | 28 | 50 s | `assets/index.android.bundle` |
| com.uniswap.mobile | 98 | 11,380 | 97,938 | 360 | 123 | 17 | 37 s | `assets/index.android.bundle` |
| com.wix.android | 96 | 19,286 | 189,541 | 474 | 160 | 33 | 46 s | `assets/index.android.bundle` |
| host.exp.exponent | 96 | 2,370 | 24,593 | 87 | 29 | 9 | 13 s | `assets/kernel.android.bundle` |
| io.metamask | 96 | 18,909 | 190,611 | 482 | 156 | 34 | 46 s | `assets/index.android.bundle` |
| me.rainbow | 96 | 10,307 | 101,142 | 396 | 121 | 30 | 33 s | `assets/index.android.bundle` |
| org.toshi | 96 | 31,131 | 228,519 | 443 | 142 | 31 | 53 s | `assets/index.android.bundle` |
| xyz.blueskyweb.app | 98 | 6,392 | 56,290 | 117 | 39 | 10 | 25 s | `assets/index.android.bundle` |

## Aggregate

Over the 20 apps with a module inventory:

| metric | value |
|---|---|
| confirmed dependencies, sum | 5,568 |
| guessed dependencies, sum | 366 |
| mean confirmed per app | 278.4 |
| mean guessed per app | 18.3 |
| wall per app | about 31 s (626 s summed over 20 apps) |

## Change against the previous measurement

The previous table (db-v3 as first written, 15 apps with retained rows) came before the module-inventory fix for prefixed `__d` and lazy two-argument `__d` (`corpus-B4`), before the 64 MiB read fix (`corpus-B1`) and before the confirm minimum-evidence rule.

- Module inventory: 2 apps went from 0 to 13,978 and 19,286 modules; 3 large-bundle apps that had no retained row are now read (19,951, 18,909 and 31,131 modules). 2 apps still report 0 modules.
- Confirmed entries on the 15 comparable apps: 4,145 before, 3,697 after; guessed entries 166 before, 236 after.
- Wall per app rose from about 22 s to about 31 s (four runs in parallel this time).

## Ground-truth apps (three open-source apps rebuilt from the matching upstream version)

Own build scored against the package lockfile truth. Offline and `--confirm` give the same numbers on bluesky and rainbow; metamask gains one confirmed package.

| app | truth packages (direct) | before: confirmed / precision / recall | offline: confirmed / precision / recall | `--confirm`: confirmed / precision / recall | `--confirm` wall |
|---|---|---|---|---|---|
| bluesky-social/social-app | 198 (198) | 44 / 68.2% / 15.2% | 47 / 63.8% / 15.2% | 47 / 63.8% / 15.2% | 504 s |
| rainbow-me/rainbow | 518 (211) | 136 / 64.7% / 17.0% | 141 / 60.3% / 16.4% | 141 / 60.3% / 16.4% | 570 s |
| MetaMask/metamask-mobile | 749 (306) | 172 / 72.7% / 16.7% | 186 / 67.7% / 16.8% | 187 / 67.9% / 17.0% | 800 s |
| Expensify/App 12a92bd (J3, deb build, db-v3 offline) | 288 (91) | 155 / 53.5% / 28.8% (J3) | 139 / 58.3% / 28.1% (direct 27.5%; after corpus-offline-precision) | not run | n/a |
| react-navigation-example 0.85.3 (held out, db-v3 offline) | 76 (60) | 17 / 100% / 22.4% | 17 / 100% / 22.4% (direct 26.7%; unchanged by corpus-offline-precision) | not run | n/a |
| Expensify/App 12a92bd (J3, module paths: db-v3-clean before, db-v4-paths-partial offline) | 288 (91) | 144 / 62.5% / 31.2% (branch deps-sig-module-paths, after the main merges) | 119 / 74.8% / 30.9% (direct 38.5%) | not run | n/a |
| react-navigation-example 0.85.3 (held out, module paths: db-v3-clean before, db-v4-paths-partial offline) | 76 (60) | 15 / 100% / 19.7% (same branch) | 11 / 100% / 14.5% (direct 16.7%) | not run | n/a |
| Expensify/App 12a92bd (J3, generic-hash rule, db-v4-paths-partial offline) | 288 (91) | 119 / 74.8% / 30.9% (module paths) | 100 / 87.0% / 30.2% (direct 37.4%; corpus-residual-fp) | not run | n/a |
| Expensify/App 12a92bd (J3, generic-hash rule, db-v3-clean offline) | 288 (91) | 144 / 62.5% / 31.2% | 134 / 66.4% / 30.9% (direct 35.2%; corpus-residual-fp) | not run | n/a |
| react-navigation-example 0.85.3 (held out, generic-hash rule) | 76 (60) | partial 11 / 100% / 14.5%; clean 15 / 100% / 19.7% | partial 10 / 100% / 13.2%; clean 14 / 100% / 18.4% (corpus-residual-fp; `expo-modules-core` lost) | not run | n/a |
| Expensify/App 12a92bd (J3, closure ownership, db-v4-paths-partial offline) | 288 (91) | 100 / 87.0% / 30.2% (generic-hash rule) | 101 / 86.1% / 30.2% (direct 37.4%; deps-closure-ownership, +`punycode.js` twin of `punycode`) | not run | n/a |
| Expensify/App 12a92bd (J3, closure ownership, db-v3-clean offline) | 288 (91) | 134 / 66.4% / 30.9% | 135 / 65.9% / 30.9% (direct 35.2%; deps-closure-ownership) | not run | n/a |
| react-navigation-example 0.85.3 (held out, closure ownership) | 76 (60) | partial 10 / 100% / 13.2%; clean 14 / 100% / 18.4% | unchanged (deps-closure-ownership) | not run | n/a |
| Expensify/App 12a92bd (J3, precision rules, db-v4-paths-partial offline) | 288 (91) | 101 / 86.1% / 30.2% (closure ownership) | 94 / 92.6% / 30.2% (direct 37.4%; corpus-precision-forks, 0 TP lost) | not run | n/a |
| Expensify/App 12a92bd (J3, precision rules, db-v3-clean offline) | 288 (91) | 135 / 65.9% / 30.9% | 131 / 67.9% / 30.9% (direct 35.2%; corpus-precision-forks) | not run | n/a |
| react-navigation-example 0.85.3 (held out, precision rules) | 76 (60) | partial 10 / 100% / 13.2%; clean 14 / 100% / 18.4% | unchanged (corpus-precision-forks) | not run | n/a |
| bluesky own build (precision rules, offline) | see DEPS.md | partial 37 / 78.4% / 14.6%; clean 46 / 73.9% / 17.2% | partial 32 / 90.6% / 14.6%; clean 43 / 79.1% / 17.2% (corpus-precision-forks) | not run | n/a |
| rainbow own build (precision rules, offline, either DB) | see DEPS.md | 107 / 76.6% / 15.8% | 106 / 77.4% / 15.8% (corpus-precision-forks) | not run | n/a |
| metamask own build (precision rules, offline, either DB) | see DEPS.md | 169 / 78.1% / 17.6% | unchanged (corpus-precision-forks) | not run | n/a |
| Expensify/App 12a92bd (J3, scattered rule, db-v4-paths-partial offline) | 288 (91) | 94 / 92.6% / 30.2% | 90 / 96.7% / 30.2% (direct 37.4%; corpus-precision-residual, 0 TP lost) | not run | n/a |
| Expensify/App 12a92bd (J3, scattered rule, db-v3-clean offline) | 288 (91) | 131 / 67.9% / 30.9% | 128 / 69.5% / 30.9% (corpus-precision-residual, 0 TP lost) | not run | n/a |
| react-navigation-example 0.85.3 (held out, scattered rule) | 76 (60) | partial 10 / 100% / 13.2%; clean 14 / 100% / 18.4% | unchanged (corpus-precision-residual) | not run | n/a |
| bluesky own build (scattered rule, offline) | see DEPS.md | partial 32 / 90.6%; clean 43 / 79.1% | partial 29 / 100% / 14.6%; clean 42 / 81.0% / 17.2% (corpus-precision-residual) | not run | n/a |
| rainbow own build (scattered rule, offline, either DB) | see DEPS.md | 106 / 77.4% / 15.8% | 104 / 78.8% / 15.8% (corpus-precision-residual) | not run | n/a |
| metamask own build (scattered rule, offline, either DB) | see DEPS.md | 169 / 78.1% / 17.6% | unchanged (corpus-precision-residual) | not run | n/a |
| Expensify/App 12a92bd (J3, + exact-version overlay `db-overlay-recall` 264 files, db-v3-clean offline) | 288 (91) | 131 / 67.9% / 30.9% (precision rules) | 207 / 80.7% / 58.0% (direct 80.2%; deps-recall-nosig; overlay population taken from this truth file, see DEPS.md) | not run | n/a |
| Expensify/App 12a92bd (J3, + exact-version overlay, db-v4-paths-partial offline) | 288 (91) | 94 / 92.6% / 30.2% (precision rules) | 170 / 96.5% / 56.9% (direct 82.4%; deps-recall-nosig) | not run | n/a |
| react-navigation-example 0.85.3 (held out, + exact-version overlay) | 76 (60) | partial 10 / 100% / 13.2%; clean 14 / 100% / 18.4% | partial 15 / 100% / 19.7%; clean 18 / 100% / 23.7% (deps-recall-nosig) | not run | n/a |
| five truth apps (one-sided twin, corpus-twin-sourcemap; partial/clean, with/without overlay) | see DEPS.md | Expensify + overlay: partial 166 / 98.8%, clean 204 / 81.9% | Expensify + overlay: partial 165 / 99.4% (FP `lodash-es` only), clean 201 / 83.1%; the other 18 runs unchanged; 0 TP lost; react-navigation 0 FP | not run | n/a |
| Expensify/App 12a92bd (J3, + truth-blind population overlay `db-overlay-pop` 739 files, db-v3-clean offline) | 288 (91) | 131 / 67.9% / 30.9% | 158 / 71.5% / 39.2% (direct 42.9%; deps-population-widen) | not run | n/a |
| Expensify/App 12a92bd (J3, + truth-blind population overlay `db-overlay-pop` 901 files, all 2,347 jobs run, current main + hash index, db-v3-clean offline) | 288 (91) | 130 / 70.0% / 31.6% | 155 / 76.1% / 41.0% (direct 42.9%; deps-population-widen-2) | not run | n/a |
| Expensify/App 12a92bd (J3, base + `db-overlay-pop` + retry overlay `db-overlay-pop2` 1,251 files, current main + hash index, db-v3-clean offline) | 288 (91) | 135 / 71.1% / 33.3% (base, same code) | 169 / 74.0% / 43.4% (direct 42.9%; deps-population-widen-3; pop alone 163 / 77.3% / 43.8%) | not run | n/a |
| react-navigation-example 0.85.3 (held out, + population overlay, db-v3-clean offline) | 76 (60) | 14 / 100% / 18.4% | 17 / 94.1% / 21.1% (direct 23.3%; FP `@babel/standalone`) | not run | n/a |
| bluesky own build (+ population overlay, db-v3-clean offline) | see DEPS.md | 43 / 79.1% / 17.2% | 47 / 78.7% / 18.7% (deps-population-widen) | not run | n/a |
| rainbow own build (hbc96, + population overlay, db-v3-clean offline) | see DEPS.md | 106 / 77.4% / 15.8% | 108 / 77.8% / 16.2% (deps-population-widen) | not run | n/a |
| metamask own build (hbc96, + population overlay, db-v3-clean offline) | see DEPS.md | 169 / 78.1% / 17.6% | 175 / 78.9% / 18.4% (deps-population-widen) | not run | n/a |
| Expensify/App 12a92bd (J3, tiny-package coverage path, db-v3-clean offline) | 288 (91) | 128 / 69.5% / 30.9% (main 8c3cc77, 1812137) | 133 / 70.7% / 32.6% (corpus-recall-bar, 0 FP added) | not run | n/a |
| Expensify/App 12a92bd (J3, tiny-package coverage path, db-v4-paths-partial offline) | 288 (91) | 93 / 96.8% / 31.2% | 99 / 97.0% / 33.3% (corpus-recall-bar) | not run | n/a |
| Expensify/App 12a92bd (J3, tiny-package coverage path, + overlay) | 288 (91) | clean 209 / 83.7% / 60.8%; partial 176 / 99.4% / 60.8% | clean 219 / 84.5% / 64.2%; partial 186 / 99.5% / 64.2% (corpus-recall-bar; overlay taken from this truth) | not run | n/a |
| react-navigation-example 0.85.3 (held out, tiny-package coverage path) | 76 (60) | clean 14 / 100% / 18.4%; partial 17 / 100% / 22.4%; + overlay 24 / 23 | clean 16 / 100% / 21.1%; partial 19 / 100% / 25.0%; + overlay 27 / 26, 100% (corpus-recall-bar) | not run | n/a |
| bluesky / rainbow / metamask own builds (tiny-package coverage path, offline, no overlay) | see DEPS.md | bluesky clean 42 / 81.0% / 17.2%, partial 39 / 100% / 19.7%; rainbow 104 / 78.8% / 15.8%; metamask 169 / 78.1% / 17.6% | bluesky 45 / 82.2% / 18.7%, 43 / 100% / 21.7%; rainbow 106 / 79.2% / 16.2%; metamask 173 / 78.6% / 18.2% (corpus-recall-bar) | not run | n/a |

| Expensify/App 12a92bd (J3, hash-index candidates, db-v3-clean offline) | 288 (91) | 128 / 69.5% / 30.9% (main 87ec7b8) | 130 / 70.0% / 31.6% (direct 35.2%; corpus-recall-candidates, +`js-base64` `react-native-uuid`, 0 FP added) | not run | n/a |
| Expensify/App 12a92bd (J3, hash-index candidates, db-v4-paths-partial offline) | 288 (91) | 90 / 96.7% / 30.2% | 92 / 96.7% / 30.9% (direct 37.4%; corpus-recall-candidates) | not run | n/a |
| react-navigation-example 0.85.3 (held out, hash-index candidates) | 76 (60) | partial 10 / 100% / 13.2%; clean 14 / 100% / 18.4% | unchanged, 0 FP (corpus-recall-candidates) | not run | n/a |
| bluesky own build (hash-index candidates, offline) | see DEPS.md | partial 29 / 100% / 14.6%; clean 42 / 81.0% / 17.2% | unchanged (corpus-recall-candidates) | not run | n/a |
| rainbow own build (hash-index candidates, offline, either DB) | see DEPS.md | 104 / 78.8% / 15.8% (direct 20.4%) | 127 / 81.9% / 20.1% (direct 26.5%; corpus-recall-candidates, +22 TP, +1 FP `digest-fetch`) | not run | n/a |
| metamask own build (hash-index candidates, offline, either DB) | see DEPS.md | 169 / 78.1% / 17.6% (direct 20.3%) | 178 / 79.2% / 18.8% (direct 20.3%; corpus-recall-candidates, +10 TP, `bs58` lost, FP `react-base16-styling` in, `eventid` out) | not run | n/a |
| five truth apps (hop-two expansion with own string sets, db-v3-clean + hash index, offline) | see DEPS.md | Expensify 130 / 70.0%; nav 14 / 100%; bluesky 42 / 81.0%; rainbow 127 / 81.9%; metamask 178 / 79.2% / 18.8% | unchanged except metamask 181 / 79.0% / 19.1% (+`bare-events` `rfdc`, +1 FP `jszip`; corpus-recall-hop-two) | not run | n/a |
| five truth apps (hop-two expansion with own string sets, db-v4-paths-partial + hash index, offline) | see DEPS.md | Expensify 92 / 96.7% / 30.9%; nav 10 / 100% / 13.2%; bluesky 29 / 100% / 14.6%; rainbow 127 / 81.9%; metamask 178 / 79.2% | Expensify 95 / 96.8% / 31.9%; nav 18 / 100% / 23.7% (0 FP); bluesky 39 / 100% / 19.7%; rainbow unchanged; metamask 181 / 79.0% / 19.1% (+23 TP, +1 FP `jszip`; corpus-recall-hop-two) | not run | n/a |
| five truth apps (full db-v4-paths over db-v3-clean, own index farms, offline, no overlay) | see DEPS.md | v3-clean: Expensify 135 / 71.1%; nav 16 / 100%; bluesky 45 / 82.2%; rainbow 129 / 82.2%; metamask 186 / 79.6%. full v4: Expensify 107 / 93.5%; nav 21 / 100%; bluesky 46 / 97.8%; rainbow 117 / 92.3%; metamask 176 / 88.6% | rainbow 115 / 93.9% / 20.8% (-2 FP `async-lock` `preact`, 0 TP lost; corpus-precision-rainbow-mm); others unchanged | not run | n/a |
Store-bundle scoring was not repeated in this measurement.

## `--confirm` on three apps without ground truth

Cap 3600 s per app, three runs in parallel, network on, no run reached the cap. "Before" is the earlier `--confirm` run (unique confirmed packages); the earlier run wrote its results back into the signature DB and had no minimum-evidence rule.

| app | offline unique | before: confirm unique | now: confirm unique | confirm-added packages now | bundled / failed candidates | wall |
|---|---|---|---|---|---|---|
| com.brex.mobile | 83 | 209 | 84 | 1 | 183 / 20 | 893 s |
| app.phantom | 119 | 144 | 119 | 0 | 208 / 73 | 977 s |
| com.baronapp.cameo | 92 | 139 | 97 | 5 | 167 / 11 | 753 s |

The precision proxy (10 confirmed packages sampled per app, checked against bundle strings and APK file names, and against the ground-truth false-positive lists) gave, over these 3 apps: 16 of 30 supported by bundle or APK evidence, 11 known false positives, 3 unverified.

## What is partial

- The 2 `totalModules: 0` apps are webpack or multi-bundle shapes (`corpus-B4`, open).
- Store-bundle ground-truth numbers and the precision proxy on the other 12 apps were not re-measured.
- Guessed-tier entries for generic English words (for example `focus`, `any`, `reject`) are still present offline; the minimum-evidence rule acts on the confirm tier.

## db-v4-paths ship readiness (2026-11-09, partial rebuild, offline)

Partial rebuild: 29,885 of 71,222 files had paths when measured; the v4 column is that DB layered over db-v3-clean for the rest (so it is a lower bound). Code: main plus the ship tooling (new demotion rules included). Same bundles and truth files as above.

Validator on the 28,557 files then done: 0 errors, all `hashScheme` 2, hbc98 14,220 / hbc99 14,337, module path coverage 89.9% (5,019,382 of 5,584,113), function `moduleId` coverage 60.9% (36.96M of 60.68M; deeper-than-factory or baseline functions have none), 261 files with under half their modules pathed.

| app | db | confirmed | TP | FP | precision | recall |
|---|---|---|---|---|---|---|
| Expensify | v3-clean | 131 | 89 | 42 | 0.679 | 0.309 |
| Expensify | v4 partial | 102 | 88 | 14 | 0.863 | 0.306 |
| react-navigation | v3-clean | 14 | 14 | 0 | 1.000 | 0.184 |
| react-navigation | v4 partial | 11 | 11 | 0 | 1.000 | 0.145 |
| bluesky | v3-clean | 43 | 34 | 9 | 0.791 | 0.172 |
| bluesky | v4 partial | 39 | 32 | 7 | 0.821 | 0.162 |
| rainbow | v3-clean | 106 | 82 | 24 | 0.774 | 0.158 |
| rainbow | v4 partial | 106 | 82 | 24 | 0.774 | 0.158 |
| metamask | v3-clean | 169 | 132 | 37 | 0.781 | 0.176 |
| metamask | v4 partial | 169 | 132 | 37 | 0.781 | 0.176 |

Rainbow and metamask are unchanged because none of their false-positive owners was rebuilt yet; re-measure after DONE (`ship-meas/meas.sh`-style run with the final DB).

## Confirm on truth apps (2026-11-09)

`deps --confirm --confirm-jobs 3` against the truth apps, with every rule on
main in place. Cells are confirmed / true positives / false positives, then
precision, recall of all and of direct truth packages. `off` is the offline run
on the same DB, `conf` the `--confirm` run; the project output directory was
fresh per run and the base DB was read-only (v4 is the partial db-v4-paths,
still being rebuilt while this ran, so its rows are a moving target).

| App | DB | off | conf | candidates (built / not built) | added by confirm |
|---|---|---|---|---|---|
| Expensify | v3-clean | 128/89/39, 0.695, 30.9% / 35.2% | 131/92/39, 0.702, 31.9% / 38.5% | 119 (67 / 52) | 3 TP, 0 FP |
| Expensify | v4-paths | 76/73/3, 0.961, 25.3% / 35.2% | 80/77/3, 0.963, 26.7% / 39.6% | 118 (62 / 56) | 4 TP, 0 FP |
| react-navigation | v3-clean | 14/14/0, 1.000, 18.4% / 21.7% | 14/14/0, 1.000, 18.4% / 21.7% | 34 (13 / 21) | 0 |
| react-navigation | v4-paths | 17/17/0, 1.000, 22.4% / 26.7% | 17/17/0, 1.000, 22.4% / 26.7% | 35 (14 / 21) | 0 |
| bluesky | v3-clean | 42/34/8, 0.810, 17.2% / 17.2% | 45/37/8, 0.822, 18.7% / 18.7% | 66 (33 / 33) | 3 TP, 0 FP |
| bluesky | v4-paths | 37/36/1, 0.973, 18.2% / 18.2% | 37/36/1, 0.973, 18.2% / 18.2% | 79 (40 / 39) | 0 |
| rainbow | v3-clean | 104/82/22, 0.788, 15.8% / 20.4% | 106/84/22, 0.792, 16.2% / 21.3% | 130 (30 / 100) | 2 TP, 0 FP |
| rainbow | v4-paths | 25/21/4, 0.840, 4.1% / 7.1% | 36/31/5, 0.861, 6.0% / 11.8% | 111 (32 / 79) | 10 TP, 1 FP |

Wall: offline 11-86 s; confirm 279-1386 s (3 workers, loaded host).

- Confirm adds 0 to 4 true positives per app on v3 and v4-paths (up to 10 on
  the rebuilding v4 rainbow row) and one false positive in total; it never
  removed a package. It is nowhere near the truth overlay: Expensify gains 1.0
  and 1.4 points, not 27.
- The limit is candidate generation, not building: on Expensify only 13-14 of
  the truth packages missing offline were ever candidates (bluesky 20-21,
  react-navigation 11-13, rainbow 26-32); the other candidates (64-73 on
  Expensify) are not truth packages.
- Not-built candidates: Metro `bundle` failures dominate (unresolved module,
  unresolved peer dependency such as `expo-modules-core`, Node-only imports
  `os`/`node:util`/`module`); 8 `maxBuffer`, 2 `npm install`, 1 hermesc. Of
  the built candidates most stop at "tier low/medium" or minimum evidence.
- 9-40 candidates per run failed with `ENOSPC: System limit for number of
  file watchers` from Metro because the host was shared with a large rebuild
  (a measurement artefact biasing confirm recall down). Among truth-package
  candidates the loss is at most 1-9 per run (react-navigation 4-5, rainbow 9,
  Expensify 1-2, bluesky 2-3).
- The one false positive: `semver-truncate@3.0.0`, a 1-module package with 26
  eligible functions, exact 69%, 0 of 1 modules exactly matched, no string
  corroboration (rainbow, v4-paths, tier high).
