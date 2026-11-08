# Metrics

Real-world `hbc2js deps` measurements. Controlled-fixture numbers live in
`docs/DEPS.md` (Ground truth, D17d); this file is the corpus layer.

- Signature DB: db-v3 (71,571 signature files), offline match + guess (no `--confirm`).
- `hbc2js` measured at commit `ce0246f6b649a6ef93857935a8559053079e9630`; `src/deps` content is the same at `a724ae1`.
- Corpus: 27 published Android APKs. Package names are not listed: counts only.

## Coverage

| | apps |
|---|---|
| Corpus | 27 |
| Hermes bundle found and read | 22 |
| No Hermes bundle in the APK (no `libhermes.so`; not React Native with Hermes) | 5 |
| Of the 22: real module inventory | 18 |
| Of the 22: `totalModules: 0` (docs/BUGS.md `corpus-B4`) | 4 |

HBC versions among the 19 retained rows: 96 (12 apps), 98 (6), 99 (1); the 3 large-bundle apps are not tallied.

## Per-app counts

`confirmed` and `guessed` are dependency counts. `bundle file` is the APK entry the bundle was read from.

| app | HBC | modules | functions | confirmed | guessed | bundle file |
|---|---|---|---|---|---|---|
| app.phantom | 96 | 19,265 | 208,026 | 401 | 17 | `assets/index.android.bundle` |
| com.baronapp.cameo | 96 | 11,174 | 60,154 | 316 | 16 | `assets/index.android.bundle` |
| com.bloomberg.android.plus | 96 | 4,995 | 58,932 | 311 | 7 | `assets/index.android.bundle` |
| com.brex.mobile | 98 | 15,014 | 109,505 | 274 | 18 | `assets/index.android.bundle` |
| com.discord | 98 | 17,037 | 120,522 | 295 | 13 | `assets/index.android.bundle` |
| com.microsoft.office.officehubrow | 96 | 0 | 9,491 | 0 | 0 | `assets/LivePersonaCard.bundle` |
| com.microsoft.teams | 96 | 482 | 4,736 | 44 | 0 | `assets/app_packages/teams-rn-common/hermes.android.bundle` |
| com.microsoft.xboxone.smartglass | 96 | 6,435 | 59,278 | 348 | 3 | `assets/index.android.bundle` |
| com.myklarnamobile | 98 | 0 | 82,098 | 0 | 0 | `assets/index.android.bundle` |
| com.oculus.twilight | 99 | 0 | 82,047 | 0 | 0 | `assets/index.android.bundle` |
| com.scee.psxandroid | 96 | 7,657 | 65,991 | 249 | 13 | `assets/index.android.bundle` |
| com.shopify.arrive | 96 | 9,461 | 69,138 | 276 | 12 | `assets/index.android.bundle` |
| com.shopify.mobile | 98 | 25,439 | 97,752 | 301 | 6 | `assets/index.android.bundle` |
| com.shopify.ping | 96 | 8,651 | 52,278 | 235 | 8 | `assets/index.android.bundle` |
| com.uniswap.mobile | 98 | 11,380 | 97,938 | 413 | 14 | `assets/index.android.bundle` |
| com.wix.android | 96 | 0 | 189,541 | 2 | 0 | `assets/index.android.bundle` |
| host.exp.exponent | 96 | 2,370 | 24,593 | 106 | 10 | `assets/kernel.android.bundle` |
| me.rainbow | 96 | 10,307 | 101,142 | 440 | 18 | `assets/index.android.bundle` |
| xyz.blueskyweb.app | 98 | 6,392 | 56,290 | 136 | 11 | `assets/index.android.bundle` |
| com.teslamotors.tesla | - | - | - | n/a | n/a | `assets/index.android.bundle` (over 64 MiB; read before the `corpus-B1` fix, counts not retained) |
| io.metamask | - | - | - | n/a | n/a | `assets/index.android.bundle` (over 64 MiB; read before the `corpus-B1` fix, counts not retained) |
| org.toshi | - | - | - | n/a | n/a | `assets/index.android.bundle` (over 64 MiB; read before the `corpus-B1` fix, counts not retained) |

## Aggregate

Over the 15 apps with a module inventory and a retained row (the 4 `totalModules: 0` apps and the 3 over-64-MiB apps are excluded):

| metric | value |
|---|---|
| confirmed dependencies, sum | 4,145 |
| guessed dependencies, sum | 166 |
| mean confirmed per app | 276.3 |
| mean guessed per app | 11.1 |

Over all 18 apps with a module inventory (including the 3 large-bundle apps, measured by extracting the bundle by hand): 5,257 confirmed (mean 292.1), 228 guessed (mean 12.7), about 22 s wall per app (about 400 s total).

## Ground-truth apps (three open-source apps rebuilt from the matching upstream version)

| app | truth packages (direct) | own build: confirmed / precision / recall | store bundle: confirmed / precision / recall |
|---|---|---|---|
| bluesky-social/social-app | 198 (198) | 44 / 68.2% / 15.2% | 37 / 67.6% / 12.6% |
| rainbow-me/rainbow | 518 (211) | 136 / 64.7% / 17.0% | 121 / 64.5% / 15.1% |
| MetaMask/metamask-mobile | 749 (306) | 172 / 72.7% / 16.7% | 144 / 70.8% / 13.6% |

## What is partial

- `--confirm` on the real-bundle apps hit the 900 s per-app cap and timed out on 3 apps, so confirm results for those apps are incomplete and are not reported here.
- The precision proxy (sample 10 confirmed packages per app and check each against APK evidence) was not done. Precision above exists only for the three ground-truth apps.
- The 3 over-64-MiB apps have no retained per-row counts.
- The 4 `totalModules: 0` apps are not investigated (`corpus-B4`).
