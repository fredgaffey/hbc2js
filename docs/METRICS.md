# Metrics

Real-world `hbc2js deps` measurements. Controlled-fixture numbers live in
`docs/DEPS.md` (Ground truth, D17d); this file is the corpus layer.

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
