# 32 — Re.Pack/webpack module inventory and multi-bundle APKs

**Status: IMPLEMENTED** (`src/deps/wscan.ts`, `src/deps/bundles.ts`).
Acceptance tests: `tests/gate/deps/webpack-inventory.test.ts`.

## Problem

`hbc2js deps` finds modules only through Metro's `__d(factory, id, deps)`
calls (`src/deps/dscan.ts`). Re.Pack builds use webpack's module system
instead. A chunk bundle runs
`(self.webpackChunk_<name> ||= []).push([[chunkIds], {id: factory, ...}])`.
The main runtime keeps the same integer-keyed object of factories in its
runtime IIFE. Neither has a `__d`, so both reported `totalModules: 0`
(docs/BUGS.md corpus-B4, shape 3). Some APKs also ship several Hermes
bundles. `extractBundleFromApk` took the first one, and in one app that
was a scope-hoisted bundle with 0 modules, listed before a plain Metro
bundle with 576 (shape 4).

## Choice

A second scanner, `wscan.ts`, sits beside `dscan.ts` and returns the same
`ModuleRegistration` records. It looks at the global function and the
functions that global creates directly (one level, as dscan does). An
object built by `NewObject*` is a webpack module object when every
by-index store into it (`PutOwnByIndex[L]`, `DefineOwnByIndex[L]`, or a
by-value store with a numeric constant key) stores a fresh
`CreateClosure`, and there is at least one such store. Each entry is one
module: the key is its module id, and the closure is its factory. Deps
are the numeric first arguments of calls through the factory's third
parameter (`__webpack_require__`, `LoadParam 3`), in call order, with
duplicates removed. `n.r(t)` and other helper calls are member calls,
not calls through the parameter itself, so they are not deps.

**Bundle kind.** `scanBundle` runs dscan first. If dscan finds anything,
the bundle is `metro` and wscan never runs, so Metro inventories cannot
change. Otherwise wscan runs only when the string table contains a
`webpackChunk` string. Re.Pack's runtime always names its chunk-loading
global, and every chunk pushes onto it. If wscan finds modules the bundle
is `webpack`, and otherwise it is `none`. `ModuleInventory.bundleKind`
carries the tag.

**Multi-bundle APKs.** `deps` reads every Hermes candidate in the APK and
builds an inventory for each one. All `webpack` bundles with the same
HBC version are merged into one inventory, because webpack module ids
are global across a main bundle and its `*.chunk.bundle` files. The
merge offsets function indices by the running function count. Metro
bundles are never merged, because each has its own module-id space and
merged dep ids would be wrong. The analysed inventory is the group with
the most modules. On a tie the one with more bytes wins, and after that
the first listed. When the APK has more than one Hermes bundle, the
report's `bundles` field lists each one with its path, kind, module
count, size and whether it was analysed.

## Rejected alternatives

- *"Every closure stored in an object is a module."* Handler maps,
  vtables and `switch` replacement tables in ordinary code look exactly
  like this. Without the Metro-first rule and the `webpackChunk` gate,
  any Metro bundle (whose `__d` already gives the true module list) and
  any scope-hoisted bundle would gain invented modules.
- *A union of every bundle in the APK.* Two Metro bundles reuse the same
  small module ids, so a union would merge unrelated modules' dep
  graphs. Picking the largest group, and listing the others, keeps the
  inventory correct. Matching each bundle separately would cost one more
  full deps pass per bundle and is left for later.

## Acceptance

From synthetic sources compiled with hermesc: a webpack chunk bundle and
a main-runtime bundle each inventory with the right ids and dep ids. A
Metro bundle that contains an integer-keyed handler map inventories
exactly its `__d` modules. A no-`__d` bundle with the same handler map
and no `webpackChunk` string has 0 modules. A zip holding a 0-module
bundle listed before a Metro bundle analyses the Metro one and lists
both. A main bundle plus a chunk bundle merge into one inventory.
