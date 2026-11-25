# boot: proving an export starts like the original

`hbc2js equiv --boot <original.hbc|bundle.js> <export-dir>` boots the original
and the exported tree under a Hermes VM behind a recording stub host and
compares what each does at startup (specs 31 and 33). Verdicts: EQUIVALENT
(exit 0), DIVERGENT (1, a real export difference: the first mismatch is in
`divergence`), INCONCLUSIVE (2, the original itself did not boot under the
stub host, or no VM), harness error (3).

The export tree must be made with `hbc2js export <app.hbc> --out <dir>
--instrument=modules --substitute none`: the export side's module records come
only from the instrumented registry. A tree exported without it is reported
INCONCLUSIVE at once, naming that command. Run `npm install` in the export
tree first: the boot check bundles it with the tree's own Metro.

Always pass the export DIRECTORY as the second argument. Do not pass a Metro
bundle you built from the export (`npx react-native bundle ...`): Metro
renumbers the modules when it rebuilds, so its trace cannot line up with the
original's module ids and the bundle form reports DIVERGENT at record 0 even
for a correct export. The bundle form is for the app's own original JS bundle
(e.g. the `index.android.bundle` an app ships before Hermes compilation).

## Getting a VM

`hbc2js setup-vm 96` installs a prebuilt Hermes VM (macOS, Linux x64;
sha256-pinned facebook/hermes v0.13.0 release). It is the only prebuilt VM
that exists for a current bytecode version: for 94/98/99 setup-vm installs
`hermesc` and says no VM exists. That is fine for `equiv --boot`: the original
runs as source, so the v96 VM boots apps built for any HBC version. Classes
and class private members (`#x`), which classic Hermes cannot parse, are
lowered first with Babel's spec-mode transforms, identically on both sides;
Babel is resolved from the export tree's own `node_modules`. A same-version VM
(needed only for bytecode mode or `equiv --hbc`) is a source build:
`tools/build-hermes-vm.sh <version>`; pass it with `--vm <path>`.

## Progress

Phase lines go to stderr (decompiling the original, booting it, bundling the
export, booting it). Under `--json` they are off, like `export` and `deps`;
add `--progress` to get them anyway.

## When the original does not boot: `boot-native.json`

The stub host answers native modules from a presence manifest derived from the
original bundle (`src/harness/native-manifest.ts`): a module the bundle cannot
run without is present, an optional probe is absent, as on a device where it
is not linked. Both sides get the same manifest. When the derivation is wrong
for an app, put `boot-native.json` next to the original file:

```json
{
  "present": {
    "ExpoLinking": true,
    "ExponentConstants": { "manifest": { "name": "MyApp", "slug": "my-app", "scheme": "myapp" } },
    "RNCAsyncStorage": {}
  },
  "absent": ["ExpoUpdates"]
}
```

- `present`: module name to `true` or an object of constants. Constants are
  readable as properties (own, enumerable: `{ ...Module }` copies them, as
  expo-constants does) and from `getConstants()`.
- `absent`: forced absent, even for RN core modules.
- Expo modules (`requireNativeModule('X')`) are reached through
  expo-modules-core's JSI installer, so `ExpoModulesCore` is present whenever
  the bundle uses Expo modules; naming the Expo module in `present` is enough.
- `ExponentConstants.manifest` is the app config Expo's build embeds in the
  APK. The stub host stands in a minimal one (scheme `hbc2jsboot`); supply the
  real `app.json` `expo` object here when the app's startup depends on it.

The INCONCLUSIVE reason names the factory that threw and its error: that is
the module to look at. `HBC2JS_BOOT_STACK=1` adds the error's stack (function
names, positions in the generated boot file) to that record.

Each side's VM runs under an address-space cap, `HBC2JS_BOOT_VM_MEMORY_MB`
(default 16384, 0 = uncapped; POSIX `ulimit -v`, so keep it >= 2048). A side
that outgrows it ends INCONCLUSIVE with "ran out of memory" in the reason
instead of drawing the kernel OOM killer.

The VM gets the globals RN's Hermes has that the standalone CLI may lack
(`TextEncoder`), installed only when absent, the same on both sides.
