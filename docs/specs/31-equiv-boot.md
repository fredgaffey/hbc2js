# 31 — `equiv --boot`: a whole-bundle boot-trace oracle

**Status: SPEC.** This is a new mode of the existing
equivalence harness (`src/harness/`), not a new tool. It lands as lane item
T8; the implementation is T8b. The
acceptance criteria in §7 are the checklist T8b turns into gate tests — no
tests ship with this spec.

## 0. Problem

The existing equivalence harness proves things one function or one module at a
time: `equiv <a.js> <b.js>` compares two execution traces (spec 06), and
`equiv --hbc <a.hbc> <b.js>` runs the original bytecode under the Hermes VM and
compares it against the decompiled JS (spec 28, `src/harness/hbc-equiv.ts`).
Both answer "does this function compute the same values". Neither answers "does
this **bundle boot** the same way".

A rebuilt bundle (`hbc2js export` -> Metro -> hermesc, spec 29) can be
per-function equivalent yet still diverge at boot, because boot behaviour is an
ordering-and-interaction property that no single function carries:

- **`__d` registration order.** Metro assigns module ids in traversal order.
  A rebuilt tree that registers the same factories in a different order changes
  which module a numeric `require(N)` resolves to — silently wrong, never
  caught by comparing any one factory.
- **`__r` require sequence.** The entry `__r(0)` drives InitializeCore and the
  app's own eager requires in a fixed order; a missing or reordered eager edge
  (spec 29 §7.1) changes it.
- **An extra, missing, or reordered native-module call.** The first thing a RN
  bundle does at boot is reach into the host: `nativeLoggingHook`,
  `__turboModuleProxy("PlatformConstants")`, `nativeModuleProxy.SourceCode`,
  timers. Two bundles that differ only in which native modules they touch, or
  in what order, are not boot-equivalent even if every function they contain is.

None of these is visible without running the whole bundle and watching the
boot-time interactions in order.

## 1. Choice

Run **both** bundles under the **real Hermes VM** (D14: the bytecode under
Hermes is ground truth, not JS under Node) behind a **stub host** — a JS
prelude that installs exactly the host globals a RN bundle reaches for during
boot, as *recording* stubs, so the bundle's top-level IIFE runs to completion
without a real device. Each run produces an ordered boot trace (a
`src/harness/trace.ts` record list); the two traces are compared with the
existing `compareTraces` (`src/harness/compare.ts`) to the first divergence.

**Mechanism — run as source, with the prelude prepended (not `hermes -b`).**
The Hermes CLI has no injectable prelude for the bytecode path: it rejects
mixing a source file and a `.hbc` ("Multiple files must use CommonJS modules",
documented at `src/harness/hermes-vm.ts` and `trace.ts` §3.2). The stub host is
JS that must run *before* the bundle IIFE, so the oracle concatenates
`preludeSource + "\n" + bundleSource` into one source file and runs it with
`hermes <file.js>` (source mode). `bundleSource` is:

- the bundle's Metro combined-bundle **JS text** when the caller has it
  (rn-template ships `tests/fixtures/bundles/rn-template-0.72/index.android.bundle`;
  the held-out app's `fetch.sh` produces `index.android.bundle` beside its
  `.hbc`) — the faithful path; or
- the **hbc2js decompilation** of a `.hbc`-only input (`decompile()`), which is
  lower fidelity and is flagged in the JSON (`sourceKind:"decompiled"`).

Two consequences make this the right call rather than a compromise:

1. **The HBC-version VM gap disappears for the source path.** `hermes <file.js>`
   runs JS regardless of the `.hbc` format version, so the held-out app
   (HBC v98, for which this repo has *no* VM) can
   be booted under any available VM (v94/v96/v99) from its `index.android.bundle`
   source. `-b` would have blocked on the missing v98 VM.
2. **Shared-pipeline noise cancels in the diff.** The oracle reports the
   *difference between the two sides*, not an absolute trace, so any artifact of
   the prelude or of decompilation that is identical on both sides produces no
   divergence (this is why the "bundle vs itself" acceptance case in §7 must
   report EQUIVALENT even though both sides went through the same imperfect
   source path).

## 2. Rejected alternatives

- **Run under a real React Native runtime (device/emulator/jsi host).** This is
  what the device tool (spec 30) is for, and it is exactly the 30-minute device cycle
  this lane exists to replace: it needs a device, a deployed app, and a screen,
  and it cannot be run in the gate on any compute node (no CI node has a device). A
  stub host reaches end-of-IIFE in milliseconds, deterministically, offline.
- **Compare bundle bytes / disassembly.** `equiv normalise` already diffs
  normalised disassembly (`src/cli.ts`), and `sizediff` (T2) diffs sizes. Byte
  or instruction identity is neither necessary (a reordered-but-equivalent
  registration is a false positive) nor sufficient (two byte-different bundles
  can boot identically; two same-looking factories can register in a different
  order) for the boot question. Only running the boot answers it.
- **Extend the Node `node:vm` sandbox (`src/harness/sandbox.ts`) instead of
  Hermes.** The sandbox is a fine *starting inventory* for the stub host (§4),
  but running boot under Node re-introduces the Node-vs-Hermes drift D14 exists
  to remove (shared-`let`-per-iteration, TDZ-by-version, `arguments` aliasing) —
  precisely the drift most likely to bite a large bundle. The stub host is
  therefore ported to a Hermes-source prelude, not run under Node.

## 3. CLI surface

```
hbc2js equiv --boot <a> <b> [--json] [--first-native N] [--seed N] [--vm <path>]
```

`<a>`/`<b>` are each a `.hbc` (decompiled first) or a `.js`/`.bundle` (used
directly). Folds into the existing `equiv` dispatch in `src/cli.ts` next to
`--hbc`; it is a mode of `equiv`, not a new subcommand.

- `--first-native N` — cap on recorded native-module interactions per side
  (default 64; §5). Beyond the cap a single `limit` record is emitted.
- `--seed N` — PRNG/clock seed passed to the stub host (default 0), so
  `Math.random`/`Date.now` are pinned identically on both sides.
- `--vm <path>` — override VM discovery (`findHermesVm`); otherwise the first
  discovered VM is used (source mode, so the version need not match either
  input).

Exit codes follow the existing `equiv` family exactly (`src/cli.ts`
`equivCode`, documented there as "exit 0 PASS 1 DIVERGENT 2 INCONCLUSIVE 3
harness error"): **0 EQUIVALENT, 1 DIVERGENT, 2 INCONCLUSIVE, 3 harness/usage
error**. See §6 for how this reconciles with the lane's "non-zero only when it
could not measure" rule.

## 4. The stub host (the deliverable)

This section is grounded in what the committed rn-template bundle actually
references and in a capability probe of the bare Hermes VM
(`tools/hermesc/v96/hermes`) — not a guess. The bare VM already provides
`globalThis`, `HermesInternal`, `print`, `Promise`, `setTimeout`,
`clearTimeout`, `setImmediate`, and the ES builtins (`Reflect`, `Proxy`,
`Symbol`, `Map`, `Set`, `Error`, ...). It does **not** provide `global`,
`setInterval`, `queueMicrotask`, `requestAnimationFrame`, `performance`,
`console`, or any RN host bridge. The stub host installs the gap.

Starting inventory is `src/harness/sandbox.ts` (the Node sandbox already models
`window`/`document`/`navigator` as recording `recordingHost` proxies, a virtual
clock, frozen `Date`, seeded `Math.random`, recording `console`/timers). Boot
needs more than that sandbox and more than T1's static free-global allow-list
(`src/tooling/check-bundle.ts`), whose comment already says the RN host-bridge
set "is decided at runtime by which polyfills ran, not statically knowable from
bundle text alone" — this spec is that runtime set.

### 4.1 What the stub host must install (rn-template, observed)

| Global | Shape | Why (observed in rn-template) |
| --- | --- | --- |
| `global` | alias `= globalThis` | bare `global` referenced 8x; bare VM lacks it |
| `nativeLoggingHook` | recording fn `(msg, level)` | 9x; RN wires `console` onto it at boot |
| `__turboModuleProxy` | recording fn `(name) -> module stub` | 1x; `TurboModuleRegistry.get(Enforcing)` |
| `nativeModuleProxy` | recording Proxy `name -> module stub` | 2x; legacy `NativeModules` |
| `nativeCallSyncHook` | recording fn | 4x; bridge sync calls |
| `nativeFabricUIManager` | recording stub object | 9x; Fabric renderer probe |
| `__fbBatchedBridge` | recording stub object | 3x; legacy bridge |
| `nativePerformanceNow` | fn `-> virtualNow` | 5x; `__BUNDLE_START_TIME__` at line 1 |
| `__fbGenNativeModule` | recording fn | 1x |
| `performance` | `{ now: () -> virtualNow }` | 35x; bare VM lacks it |
| `setInterval`/`clearInterval` | recording, ordered | bare VM lacks `setInterval` |
| `queueMicrotask` | recording | 6x; bare VM lacks it |
| `requestAnimationFrame`/`cancelAnimationFrame` | recording, ordered | 9x |
| `requestIdleCallback`/`cancelIdleCallback` | recording | 5x |
| `console` | recording (`sandbox.ts` shape) | bare VM lacks it; bundle also installs its own via `nativeLoggingHook` |

Provided by the bundle itself, **not** the host, and therefore only *observed*,
never installed: `__d`/`__r`/`__c`/`__registerSegment` (Metro require runtime,
assigned onto `global` at the top of the IIFE with the
`__METRO_GLOBAL_PREFIX__` prefix, empty in this bundle), `__DEV__` (set `=false`
inline), `ErrorUtils` (5x; RN's `setUpErrorHandling` installs it). `HermesInternal`
is provided by the real VM and must **not** be clobbered. rn-template references
no `WeakRef`/`FinalizationRegistry`/`TextEncoder`/`structuredClone`, so the stub
need not provide them (add on observation, per T1's allow-list rule, never a
pre-emptive guess).

The natural stopping point is **end of the top-level IIFE = after `__r(0)`
returns**. `__r(0)` runs InitializeCore and requires the app module, which calls
`AppRegistry.registerComponent` (8x) — but **not** `runApplication` (called only
by a real host to render). So boot completes through app registration with **no
view host, no renderer, no screen** required. This is why a stub host suffices.

### 4.2 The held-out app (react-navigation-example-0.85.3, HBC v98)

Not yet observed: its bundle is not committed (regenerated by
`tests/fixtures/bundles/react-navigation-example-0.85.3/fetch.sh`, needs network
+ pnpm) and there is no v98 VM. What can be stated: RN 0.85 is the same host
*family* (same `nativeLoggingHook`/`__turboModuleProxy`/`nativeModuleProxy`
contract), but new-architecture/bridgeless is the default there, so
`RN$Bridgeless` is likely truthy and the `nativeFabricUIManager`/
`__turboModuleProxy` paths dominate while the legacy `nativeModuleProxy`/
`__fbBatchedBridge` paths are exercised less. **T8b must confirm the exact
stub-host set for v98** by running `fetch.sh`, then booting its
`index.android.bundle` *source* under any available VM (the source path makes
the missing v98 VM a non-blocker, §1) and adding any host name the boot throws
on — the same "run bare, add what it throws on, repeat" loop used to derive
§4.1. Mark v98-specific additions in the T8b report and this pack's Gotchas.

## 5. The boot trace — reuse existing records, add none

Every boot interaction maps onto an existing `src/harness/trace.ts` record; no
new kind is proposed (the pack asks to prefer reuse, and the `fn` field already
namespaces the interaction). The recording stubs and the wrapped runtime call
the sandbox's `emit`:

| Boot interaction | Record | Fields |
| --- | --- | --- |
| trace header | `MetaRecord` | `engine`, `seed` |
| `__d(factory, id, deps)` registration | `CallRecord` | `fn:"__d"`, `args:[id, JSON(deps)]` |
| `__r(id)` require | `CallRecord` | `fn:"__r"`, `args:[id]`, `throws?` |
| `__turboModuleProxy(name)` | `CallRecord` | `fn:"__turboModuleProxy"`, `args:[name]` |
| `nativeModuleProxy[name]` get | `CallRecord` | `fn:"nativeModuleProxy.get"`, `args:[name]` |
| `nativeLoggingHook(msg, level)` | `CallRecord` | `fn:"nativeLoggingHook"`, `args:[level]` (msg not recorded: it carries app text) |
| timer schedule (`setTimeout`/`setInterval`/`queueMicrotask`/rAF) | `CallRecord` | `fn:"setTimeout"...`, `args:[delay]` |
| virtual clock advance | `TickRecord` | `t` |
| `console`/`print` output | `OutRecord` | `ch`, `s`, `a` |
| host global installed by bundle (`window`, `ErrorUtils`, ...) | `HostSetRecord` | `o`, `p`, `v` |
| boot threw before end-of-IIFE | `ErrRecord` | `phase:"boot"`, `name`, `message` |
| first-N native cap / record cap hit | `LimitRecord` | `why` |
| reached end of top-level IIFE | `EndRecord` | — |

**How `__d`/`__r` get recorded** (they are bundle-defined, not host-provided):
the prelude installs `Object.defineProperty` set-traps on `globalThis.__d`,
`globalThis.__r`, `globalThis.__c`, `globalThis.__registerSegment` (and the
`__METRO_GLOBAL_PREFIX__` variants). When Metro's require-runtime assigns them
at the top of the IIFE, the trap captures the real function and substitutes a
recording wrapper that emits the `CallRecord` in call order, then delegates.

Only the **first `--first-native N`** (default 64) native-module interactions
per side are recorded; the rest collapse to one `LimitRecord`, so the trace
stays bounded on a large bundle. `__d`/`__r`/timers are recorded in full
(bounded by module count) unless the global record cap (`runner.ts`) fires.

## 6. Diff and exit contract

Comparison is `compareTraces(a, b)` (`src/harness/compare.ts`), reused
unchanged. It already: filters to comparable records, scans to the **first
divergence**, returns a three-valued `verdict`
(`EQUIVALENT`/`DIVERGENT`/`INCONCLUSIVE`), a `divergence` `{index, a, b}` with
both rendered records, `context` (the `contextAround` `-`/`+` window, ±3
records), and stops at any budget/`limit` marker so a truncated side is never
mis-read as a divergence.

`equiv --boot` maps that verdict to an exit code and a JSON object:

- **EQUIVALENT** -> exit 0, `ok:true`. Both boots reached `EndRecord` and their
  comparable records matched.
- **DIVERGENT** -> exit 1, `ok:true`. A first divergence was found; print its
  index, both records, and `context`. **This is the oracle's purpose.**
- **INCONCLUSIVE** -> exit 2, `ok:false`, `reason` set. Includes: a side that
  threw before `EndRecord` (a stub-host gap, reported with the `ErrRecord`), no
  VM found, both sides observing nothing, or a budget cut-off. **Never PASS**
  (HA-01, the three-valued rule).
- usage / unreadable input -> exit 3.

**Reconciling with the lane contract.** The lane rule is "exit non-zero only
when it could not measure". An equivalence oracle is the documented exception
the brief names: a DIVERGENT verdict *is* a successful measurement whose result
is "different", and — exactly like the existing `equiv`/`equiv --hbc` verdicts
and like `diff(1)` — it exits non-zero so a script/CI can act on it. So
`ok:true` for both EQUIVALENT and DIVERGENT (both measured); `ok:false` only for
INCONCLUSIVE (the true "could not measure"). The exit code carries the
three-way result (0/1/2), the `verdict` field states it in words, and a field
that could not be obtained is `null` with a `*Source` sibling, per the lane.

`--json` prints one object:

```json
{
  "schema": "equiv-boot/1", "tool": "equiv", "mode": "boot",
  "verdict": "DIVERGENT", "ok": true,
  "a": {"sourceKind": "bundle-js", "records": 812, "reachedEnd": true},
  "b": {"sourceKind": "decompiled", "records": 809, "reachedEnd": true},
  "divergence": {"index": 137, "a": "call __d [317,[...]]", "b": "call __d [318,[...]]"},
  "context": "  135   call __d ...\n  137 - call __d [317...]\n  137 + call __d [318...]",
  "reason": null, "reasonSource": null,
  "vm": "tools/hermes-vm/v94/bin/hermes", "seed": 0
}
```

## 7. Acceptance criteria (the T8b checklist)

Each becomes a gate test when T8b lands (fixtures under
`tests/fixtures/tooling/` or reusing `tests/fixtures/bundles/`); none ships with
this spec.

1. **rn-template reaches end-of-IIFE under the stub host.** Booting
   `tests/fixtures/bundles/rn-template-0.72/index.android.bundle` under the stub
   host emits an `EndRecord` and at least one `__d`, one `__r`, and one native
   interaction (no `ErrRecord` with `phase:"boot"`). If any host name is
   missing, the test fails with the thrown name — that name is then added to
   §4.1, never worked around.
2. **The held-out app reaches end-of-IIFE under the stub host (sweep tier).**
   Same, on the held-out app's `index.android.bundle` (source path, any VM),
   guarded by `requireSweep`. If v98 needs host names beyond §4.1, they are
   added and recorded (§4.2).
3. **A known-equivalent pair reports EQUIVALENT.** `equiv --boot X X` (a bundle
   vs itself) exits 0, `verdict:"EQUIVALENT"`, `divergence:null` — shared source
   path and prelude cancel, so identical inputs never diverge.
4. **An intentionally divergent pair is caught at the first divergence.** A pair
   differing in exactly one boot interaction (e.g. a fixture whose `__d`
   registrations are reordered, or one extra `__turboModuleProxy` call) exits 1,
   `verdict:"DIVERGENT"`, with `divergence.index` pointing at the first
   differing record and `context` showing both sides.
5. **A side that cannot boot is INCONCLUSIVE, never PASS and never DIVERGENT
   from a real difference.** If one side throws before `EndRecord`, the verdict
   is INCONCLUSIVE, exit 2, `ok:false`, `reason` naming the boot error — it must
   not be reported as EQUIVALENT (no `EndRecord`) nor as a spurious DIVERGENT.
6. **`--first-native N` bounds the trace.** On a large bundle the recorded
   native interactions are capped at N with one `LimitRecord`; `__d`/`__r`
   counts are unaffected.
7. **Exit codes match §6** for all of EQUIVALENT/DIVERGENT/INCONCLUSIVE/usage.

## 8. What T8b must build (so it slots into this spec)

- `src/harness/boot-equiv.ts`: `bootTrace(source, {seed, firstNative, vm})`
  producing a `Trace`, and `compareBootTraces(a, b)` wrapping `compareTraces`.
  The stub-host prelude is a Hermes-source string built from the §4.1 table
  (port of `sandbox.ts`'s recording/clock model to a prelude); the `__d`/`__r`
  set-trap interception (§5) lives here.
- Source acquisition: reuse `decompile()` for `.hbc` inputs, pass `.js`/`.bundle`
  through unchanged; set `sourceKind` accordingly.
- VM run: reuse `findHermesVm`/`runHermes` (`src/harness/hermes-vm.ts`) in
  **source** mode (not `-b`); the prelude emits NDJSON trace records on a
  channel the runner parses back into `TraceRecord`s (the trace is produced
  *inside* the VM by the prelude's `emit`, printed as NDJSON, then read back —
  since source mode has no out-of-band channel).
- `src/cli.ts`: add `--boot` to the `equiv` dispatch, `--first-native`/`--seed`/
  `--vm` parsing, the §6 JSON object, and the exit-code mapping via the existing
  `equivCode` path.
- Confirm the v98 stub-host set (§4.2) and record any additions here and in the
  pack's Gotchas.
