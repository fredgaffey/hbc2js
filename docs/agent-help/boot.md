# boot: proving an export starts like the original

`hbc2js equiv --boot <original.hbc|bundle.js> <export-dir>` boots the original
and the exported tree under a Hermes VM behind a recording stub host and
compares what each does at startup (specs 31 and 33). Verdicts: EQUIVALENT
(exit 0), DIVERGENT (1, a real export difference: the first mismatch is in
`divergence`), INCONCLUSIVE (2, the original itself did not boot under the
stub host, or no VM), harness error (3).

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
  readable as properties and from `getConstants()`.
- `absent`: forced absent, even for RN core modules.
- Expo modules (`requireNativeModule('X')`) are reached through
  expo-modules-core's JSI installer, so `ExpoModulesCore` is present whenever
  the bundle uses Expo modules; naming the Expo module in `present` is enough.
- `ExponentConstants.manifest` is the app config Expo's build embeds in the
  APK. The stub host stands in a minimal one with no URI scheme; supply the
  real `app.json` `expo` object here when the app's startup depends on it.

The INCONCLUSIVE reason names the factory that threw and its error: that is
the module to look at.
