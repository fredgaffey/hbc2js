# hbc2js — instructions for AI contributors

Read `docs/DECISIONS.md` for the binding architecture decisions. Lane packs are private working notes under `local/lanes/<lane>.md` (gitignored, may be absent); `docs/DECISIONS.md` and the specs are the public orientation. Open other docs only when your task needs them.

Process (v2): a **new subsystem** ships with a short general
spec (half a page: problem, choice, rejected alternative) plus acceptance
tests, before implementation. An item **inside an existing subsystem** is
test-first, done by one worker: write the failing test, paste the failing run
in the report, make it pass, one doc paragraph, pack rewrite last. Design
decisions that the spec/pack doesn't settle go in the pack's Gotchas or the
worker's report, not a separate ledger.

Hard rules:
- **Never copy code from hermes-dec** (AGPL). It is a behaviour oracle only. Derive opcode tables from the MIT-licensed Hermes repo (`include/hermes/BCGen/HBC/BytecodeList.def`) or from observation.
- Must work on macOS and Linux; avoid platform-specific paths/binaries in core code.
- Test count must never drop; `tests/gate/docs/test-count.test.ts` checks it against `docs/test-count-baseline.json`.
- **Every bug fix ships with a regression test that fails before the fix and passes after.** If the bug was in decompilation semantics, that test is a new construct fixture (`tests/fixtures/constructs/`, compiled for every version via `build.sh`). Name the test after the review/issue that found it. A `docs/BUGS.md` row is only for when a test is genuinely impossible — a bug is never fixed silently and never left undocumented.
- **Gate cadence.** Run the test files your change affects while you work. Run the full `npm run typecheck && npm test` once per landing block, before any push.
