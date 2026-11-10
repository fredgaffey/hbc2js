/** Spec 31 §4.2 / spec 33 L4: the stub host's native-module presence
 *  manifest. Which native modules (legacy `NativeModules`, TurboModules,
 *  Expo modules) exist, with which constants. A module not in `present` is
 *  absent: `nativeModuleProxy.X` is undefined, `__turboModuleProxy("X")` is
 *  null, `expo.modules.X` is undefined, exactly as on a device where it is
 *  not linked. One manifest is derived from the ORIGINAL bundle and handed
 *  to both sides of a comparison, so a stub gap shows up on both.
 *
 *  Derivation rule (first match wins):
 *   1. Per-app override (`boot-native.json` next to the original):
 *      `absent` names are absent, `present` names (object of constants, or
 *      `true`) are present.
 *   2. RN core (Android, new architecture): the curated lists below.
 *   3. Bundle evidence of a *required* module: `getEnforcing('X')`, or an
 *      Expo `requireNativeModule('X')` that is not inside a `try` (a
 *      missing one would crash the app at startup, so a booting app has it),
 *      or a lookup immediately called as a JSI installer
 *      (\`get('ExpoModulesCore')?.installModules()\`), or the last
 *      alternative of a lookup chain \`get(A) || get(B) || get(C)\` (the
 *      library's canonical module; the earlier ones are probes).
 *      Also a module whose absent fallback is a throwing `new Proxy`
 *      (`NativeModules.X ? NativeModules.X : new Proxy(...)`, the
 *      library template's linking error), or one bound to a variable and
 *      dereferenced with no guard anywhere in its factory, or whose factory
 *      throws when it is missing, or named in a library's
 *      "NativeModule.X is null. To fix this issue" error.
 *   4. Bundle evidence of a library's *own* native spec: a lookup call
 *      (`get` / `requireOptionalNativeModule` / `requireNativeModule`) that
 *      is the last expression of its Metro factory, i.e. a codegen-style
 *      `Native<X>` module whose whole job is to export that one module. A
 *      library ships its spec module with its native code.
 *   5. Anything else (earlier alternatives in `A || B`, `try { ... }`,
 *      `null != get(...)`, `NativeModules.X &&`) is absent. */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type NativeConstants = Readonly<Record<string, unknown>>;

export interface NativeManifest {
  readonly schema: "boot-native/1";
  /** Present modules and their constants (`getConstants()` result, and
   *  readable as properties, as RN's legacy bridge and Expo modules expose
   *  them). */
  readonly present: Readonly<Record<string, NativeConstants>>;
}

/** The per-app override file, looked for next to the original bundle. */
export const NATIVE_OVERRIDE_FILE = "boot-native.json";

const DIMS = { width: 1080, height: 2340, scale: 2.75, fontScale: 1, densityDpi: 440 };

/** RN core native modules an Android release app links (CoreModulesPackage,
 *  MainReactPackage, the C++ TurboModules), with fixed, app-independent
 *  constants where RN reads them at module-eval or render time. */
export const RN_CORE_PRESENT: Readonly<Record<string, NativeConstants>> = {
  PlatformConstants: { isTesting: false, isDisableAnimations: false, reactNativeVersion: { major: 0, minor: 0, patch: 0, prerelease: null }, Version: 34, Release: "14", Serial: "unknown", Fingerprint: "stub", Model: "stub", Manufacturer: "stub", Brand: "stub", ServerHost: "", uiMode: "normal" },
  DeviceInfo: { Dimensions: { window: DIMS, screen: DIMS, windowPhysicalPixels: DIMS, screenPhysicalPixels: DIMS } },
  I18nManager: { isRTL: false, doLeftAndRightSwapInRTL: true, localeIdentifier: "en_US" },
  StatusBarManager: { HEIGHT: 24, DEFAULT_BACKGROUND_COLOR: 0 },
  SourceCode: { scriptURL: "" },
  UIManager: {}, ExceptionsManager: {}, Timing: {}, AppState: { initialAppState: "active" }, Appearance: {},
  DeviceEventManager: {}, NativeAnimatedModule: {}, NativeAnimatedTurboModule: {}, ImageLoader: {}, Networking: {},
  WebSocketModule: {}, BlobModule: { BLOB_URI_SCHEME: "content", BLOB_URI_HOST: null }, FileReaderModule: {}, Clipboard: {},
  Vibration: {}, ToastAndroid: { SHORT: 0, LONG: 1, TOP: 48, BOTTOM: 80, CENTER: 17 }, AccessibilityInfo: {},
  DialogManagerAndroid: { buttonClicked: "buttonClicked", dismissed: "dismissed", buttonPositive: -1, buttonNegative: -2, buttonNeutral: -3 },
  PermissionsAndroid: {}, ShareModule: {}, IntentAndroid: {}, SoundManager: {}, HeadlessJsTaskSupport: {},
  FrameRateLogger: {}, DevSettings: {}, DevMenu: {}, SegmentFetcher: {},
  NativeReactNativeFeatureFlagsCxx: {}, NativeMicrotasksCxx: {}, NativeIdleCallbacksCxx: {}, NativeDOMCxx: {},
  NativePerformanceCxx: {}, NativeIntersectionObserverCxx: {}, NativeMutationObserverCxx: {},
};

/** RN core modules that exist only on iOS (or only in debug builds): absent
 *  on an Android release device, whatever the bundle's evidence says. */
export const RN_CORE_ABSENT: readonly string[] = [
  "ActionSheetManager", "PushNotificationManager", "KeyboardObserver", "ModalManager", "AccessibilityManager",
  "LinkingManager", "DevLoadingView", "RedBox", "LogBox", "BugReporting", "HMRClient",
];

/** Methods a device answers with a Promise, and the value it resolves to
 *  on a cold start (no deep link). A recording stub otherwise returns
 *  undefined, and module-eval code like `Linking.getInitialURL().then(…)`
 *  (Expensify) throws on both sides. Keyed by module, then method. */
export const PROMISE_METHODS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  IntentAndroid: { getInitialURL: null, canOpenURL: false, openURL: null },
  LinkingManager: { getInitialURL: null, canOpenURL: false, openURL: null },
};
/** Constants for well-known third-party modules once they are present. */
const KNOWN_CONSTANTS: Readonly<Record<string, NativeConstants>> = {
  // expo-constants, bare workflow, no embedded manifest (the app.config is
  // only embedded by expo's build scripts; null is what a bare app reads).
  ExponentConstants: { executionEnvironment: "bare", appOwnership: null, isHeadless: false, statusBarHeight: 24, deviceName: "stub", systemFonts: [], sessionId: "00000000-0000-0000-0000-000000000000", manifest: null, platform: { android: {} } },
};

export interface NativeOverride {
  readonly present?: Readonly<Record<string, NativeConstants | true>>;
  readonly absent?: readonly string[];
}

const LOOKUP = /(getEnforcing|\.get|requireNativeModule\)?|requireOptionalNativeModule\)?)\(\s*["']([A-Z][\w$]*)["']\s*\)/g;

/** Rules 3 and 4 over a Metro bundle source (exported for tests). */
export function bundleEvidence(source: string): { required: Set<string>; spec: Set<string> } {
  const required = new Set<string>();
  const spec = new Set<string>();
  LOOKUP.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LOOKUP.exec(source)) !== null) {
    const kind = m[1]!;
    const name = m[2]!;
    const before = source.slice(Math.max(0, m.index - 48), m.index);
    const after = source.slice(m.index + m[0].length, m.index + m[0].length + 24);
    const inTry = /try\s*\{\s*return[^;{}]*$/.test(before);
    if (kind === "getEnforcing" || (kind.startsWith("requireNativeModule") && !inTry)) required.add(name);
    // A JSI installer the library itself calls at startup
    // (\`get('ExpoModulesCore')?.installModules()\`): that library's own
    // native half, so present even inside a try.
    if (/^\s*\??\.\s*install\w*\(/.test(after)) required.add(name);
    // The last alternative of a lookup chain (\`get(A) || get(B) || get(C)\`):
    // a library's final fallback is its canonical module, the one its
    // autolinked native half registers (async-storage throws when the
    // whole chain is null).
    if (/\|\|\s*[\w$.()]*$/.test(before) && /^\s*[;:,)}]/.test(after)) required.add(name);
    // Last expression of the factory: `...('X')},<id>,[` (Metro), or the
    // `...('X')}` end of a factory body without Metro's trailer.
    if (!inTry && /^\s*\}\s*(?:,\s*\d+\s*,\s*\[|\)|$)/.test(after) && !/(?:\|\||&&|\?\?|!=|==)\s*[^,;=]*$/.test(before)) spec.add(name);
  }
  // A library that falls back to a throwing Proxy when its module is
  // missing (create-react-native-library's LINKING_ERROR template:
  // `NativeModules.X ? NativeModules.X : new Proxy({}, {get(){throw …}})`)
  // cannot work without it; a shipping app links it.
  LINKED_OR_THROW.lastIndex = 0;
  while ((m = LINKED_OR_THROW.exec(source)) !== null) required.add(m[1]!);
  // The library's own "NativeModule.X is null. To fix this issue…" message
  // (netinfo, device-info, async-storage…): it throws without X.
  IS_NULL_MSG.lastIndex = 0;
  while ((m = IS_NULL_MSG.exec(source)) !== null) required.add(m[1]!);
  // An app's own module bound once and dereferenced with no guard anywhere
  // in its factory (`n=r(d[2]).NativeModules.BootSplash; … n.logoSizeRatio`
  // at module-eval time): without it the factory throws on a device too.
  UNGUARDED_BIND.lastIndex = 0;
  while ((m = UNGUARDED_BIND.exec(source)) !== null) {
    const v = m[1]!;
    const end = source.indexOf("__d(", m.index);
    const body = source.slice(m.index + m[0].length, end < 0 ? undefined : end);
    const e = v.replace(/\$/g, "\\$");
    const deref = new RegExp(`(?<![\\w$.])${e}\\.[A-Za-z_$]`).test(body);
    const guard = new RegExp(`(?<![\\w$.])${e}\\s*(?:\\?|&&|\\|\\||[!=]=)|(?:!|[!=]=\\s*|&&\\s*|\\?\\s*|if\\s*\\(\\s*)${e}(?![\\w$])`).test(body);
    // …or guarded only to throw when it is missing (`!t&&(…)throw new
    // Error("… is null")`, react-native-device-info).
    const throwsIfMissing = new RegExp(`!\\s*${e}(?![\\w$])[^;]{0,300}?\\bthrow\\b`).test(body);
    if ((deref && !guard) || throwsIfMissing) required.add(m[2]!);
  }
  return { required, spec };
}
const UNGUARDED_BIND = /(?<![\w$.])([\w$]+)\s*=\s*[\w$.()[\]]*\.NativeModules\.([A-Z][\w$]*)\s*[;,]/g;
const IS_NULL_MSG = /NativeModule\.([A-Z][\w$]*) is null\. To fix/g;
const LINKED_OR_THROW = /\.([A-Z][\w$]*)\s*\?\s*[\w$.]*\.\1\s*:\s*new\s+Proxy\s*\(/g;

function readOverride(path: string | undefined): NativeOverride {
  if (path === undefined || !existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as NativeOverride;
}

/** The override file for an original bundle path (`boot-native.json` in its
 *  directory), or undefined. */
export function overrideFor(originalPath: string): string | undefined {
  const p = join(dirname(originalPath), NATIVE_OVERRIDE_FILE);
  return existsSync(p) ? p : undefined;
}

/** Derive the manifest for one bundle source (the original's), per the rule
 *  in this file's header. */
export function deriveNativeManifest(source: string, override: NativeOverride | string | undefined = undefined): NativeManifest {
  const ov = typeof override === "string" || override === undefined ? readOverride(override) : override;
  const { required, spec } = bundleEvidence(source);
  const absent = new Set([...(ov.absent ?? []), ...RN_CORE_ABSENT]);
  const present: Record<string, NativeConstants> = {};
  const add = (name: string, c?: NativeConstants): void => { present[name] = { ...(KNOWN_CONSTANTS[name] ?? {}), ...(c ?? {}) }; };
  for (const [k, v] of Object.entries(RN_CORE_PRESENT)) if (!(ov.absent ?? []).includes(k)) add(k, v);
  for (const n of [...required, ...spec]) if (!absent.has(n) && !(n in present)) add(n);
  for (const [k, v] of Object.entries(ov.present ?? {})) add(k, v === true ? undefined : v);
  const sorted: Record<string, NativeConstants> = {};
  for (const k of Object.keys(present).sort()) sorted[k] = present[k]!;
  return { schema: "boot-native/1", present: sorted };
}
