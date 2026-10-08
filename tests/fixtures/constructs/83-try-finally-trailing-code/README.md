# 83-try-finally-trailing-code — QUARANTINED (no `vNN.hbc` committed)

Regression fixture for the **2026-09-21** `docs/BUGS.md` row: a `try`/`finally`
whose TRAILING code (the statements after the `finally`) is swallowed into the
try region, so a store the original performs on the normal path *before* that
trailing code is relocated to *after* it.

## Why there are no `.hbc` files here

`tests/support/fixtures.ts` discovers fixtures by their `vNN.hbc` binaries
(`BINARY_RE`). Committing them would enrol this fixture in the gate and sweep
tiers immediately and turn them **red on v84/v94/v96**, ambushing the other
sessions working in this repo. The source and expected output are committed so
the bug is fully reproducible; the binaries are left out deliberately.

`versions.txt` is not the right mechanism here — it excuses fixtures hermesc
cannot *compile*. This one compiles fine at all five versions; it is the
*decompile* that is wrong.

## Activating it (do this as part of the fix)

```sh
tests/fixtures/build.sh          # regenerates v84/v94/v96/v98/v99.hbc here
```

Then it participates in the normal tiers like any other construct fixture.

## Reproducing the bug right now

```sh
tools/hermesc/v96/hermesc -emit-binary -O -out /tmp/83.hbc \
    tests/fixtures/constructs/83-try-finally-trailing-code/source.js
tools/hermesc/v96/hermes -b /tmp/83.hbc     # inside-try:true | after-try:false | threw:boom
node --experimental-strip-types src/cli.ts /tmp/83.hbc /tmp/83.out.js
tools/hermesc/v96/hermes /tmp/83.out.js     # inside-try:true | after-try:TRUE  | threw:boom
```

## Version matrix

| hermesc | verdict | emitted shape |
|---|---|---|
| v84 | **FAIL** | `try { ... } finally { flag = false; }` — trailing call pulled inside |
| v94 | **FAIL** | same |
| v96 | **FAIL** | same |
| v98 | PASS | `__pc`-guarded `catch`, correctly bounded try region |
| v99 | PASS | same |

So the `finally`-emitting path is the buggy one and the `__pc`-guarded `catch`
path is correct.

(v98 additionally needs `--opcode-table=hbc98-late` to decompile at all — a
separate, pre-existing `E_LAYOUT_AMBIGUOUS` issue, unrelated to this bug.)
