// src/deps/optional-probes.ts -- which package detections a bare native-module /
// package-name string cannot establish on its own.
//
// Libraries feature-detect their optional peers (`TurboModuleRegistry.get("X")
// != null`, `UIManager.getViewManagerConfig("RNCMaskedView")`, `globalThis.expo?.
// modules?.ExpoFontLoader`): the string is in the bundle whether or not the
// peer is installed. Measured on a bare RN 0.88 app (no Expo at all): expo,
// expo-asset, expo-constants, expo-font, edge-to-edge and masked-view were all
// "detected" from such probes.

/** `expo` and every `expo-*` SDK package (not `@expo/*` / `@expo-google-fonts/*`). */
export function isExpoPackage(pkg: string): boolean {
  return pkg === "expo" || pkg.startsWith("expo-");
}

/** Packages other popular libraries probe for: a native-module / package-name
 *  string alone is no evidence they are installed. */
const PROBED_OPTIONAL_PEERS: ReadonlySet<string> = new Set(["@react-native-masked-view/masked-view", "react-native-edge-to-edge"]);

/** Evidence kinds that are string probes (they appear in the probing library too). */
const PROBE_KINDS: ReadonlySet<string> = new Set(["native-module", "package-name-string", "url-host", "npm-search"]);

export type ProbeVerdict = "no-expo-runtime" | "optional-probe" | null;

/** Why a guessed/hinted package must NOT be reported (null: keep it).
 *  `expoRuntime`: expo-modules-core itself is in the bundle. */
export function probeVerdict(pkg: string, kinds: ReadonlySet<string>, expoRuntime: boolean): ProbeVerdict {
  if (isExpoPackage(pkg) && !expoRuntime) return "no-expo-runtime";
  if (PROBED_OPTIONAL_PEERS.has(pkg)) {
    // react-native-edge-to-edge is a hard dependency of the Expo SDK; elsewhere it is a probe.
    if (pkg === "react-native-edge-to-edge" && expoRuntime) return null;
    if (![...kinds].some((k) => !PROBE_KINDS.has(k))) return "optional-probe";
  }
  return null;
}
