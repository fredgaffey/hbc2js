// src/deps/native-modules.ts — curated `NativeModules.X` / `TurboModuleRegistry
// .get('X')` name -> npm package map for the D17a guess stage. Native-module
// names are close to a perfect key: they're chosen by the package author,
// rarely renamed across versions, and almost never collide between unrelated
// packages (unlike a generic function-shape hash). Curated by hand from each
// package's own source (the `NativeModules.<Name>`/`TurboModuleRegistry.get`
// call site in its JS entry point) — not exhaustive, extend as needed.

// A `Map`, not a plain object literal: an object literal is vulnerable to
// prototype-chain lookups for keys that happen to collide with
// `Object.prototype` members (`hasOwnProperty`, `toString`, `constructor`,
// ...) — a native-module name string pulled straight out of a bundle's own
// string table is untrusted input, so `NATIVE_MODULE_TO_PACKAGE["hasOwnProperty"]`
// must return `undefined`, not `Object.prototype.hasOwnProperty`.
export const NATIVE_MODULE_TO_PACKAGE: ReadonlyMap<string, string> = new Map(
  Object.entries({
  // Core / community modules split out of react-native itself.
  RNCAsyncStorage: "@react-native-async-storage/async-storage",
  RNCNetInfo: "@react-native-community/netinfo",
  RNCClipboard: "@react-native-clipboard/clipboard",
  RNCSlider: "@react-native-community/slider",
  RNCMaskedView: "@react-native-masked-view/masked-view",
  RNCViewPager: "react-native-pager-view",
  RNCPushNotificationIOS: "@react-native-community/push-notification-ios",
  RNCWebView: "react-native-webview",
  RNCWebViewModule: "react-native-webview", // native-module-name variant of RNCWebView (the view manager)
  RNCCheckbox: "@react-native-community/checkbox",
  RNDateTimePicker: "@react-native-community/datetimepicker",
  RNDatePicker: "@react-native-community/datetimepicker", // iOS-side native-module name for the same package

  // Navigation / gesture / screens cluster.
  RNGestureHandlerModule: "react-native-gesture-handler",
  RNSScreenContainer: "react-native-screens",
  RNSScreen: "react-native-screens",
  RNSScreenStack: "react-native-screens",
  RNSSearchBar: "react-native-screens",
  RNSafeAreaContext: "react-native-safe-area-context",
  RNCSafeAreaProvider: "react-native-safe-area-context",
  RNCSafeAreaContext: "react-native-safe-area-context", // the package's own native-module name (as opposed to RNCSafeAreaProvider's view-manager name)
  RNSModalScreen: "react-native-screens",
  RNSModule: "react-native-screens",
  RNSSafeAreaView: "react-native-screens",
  RNSStackHost: "react-native-screens",
  RNSStackScreen: "react-native-screens",
  RNSTabsHost: "react-native-screens",
  RNSTabsScreen: "react-native-screens",
  RNSScreenStackHeaderConfig: "react-native-screens",
  RNSScreenStackHeaderSubview: "react-native-screens",
  RNGestureHandlerButton: "react-native-gesture-handler",
  RNGestureHandlerRootView: "react-native-gesture-handler",

  // Reanimated / animation.
  ReanimatedModule: "react-native-reanimated",
  NativeReanimatedModule: "react-native-reanimated",
  RNAnimatedModule: "react-native", // core Animated native module, not a package

  // SVG / images / media.
  RNSVGModule: "react-native-svg",
  RNSVGSvgViewAndroid: "react-native-svg",
  RNSVGSvgViewModule: "react-native-svg",
  FastImageView: "react-native-fast-image",
  LottieAnimationView: "lottie-react-native", // real npm native module
  ImageResizer: "react-native-image-resizer",
  RNSoundModule: "react-native-sound",
  VideoManager: "react-native-video",
  RNCImagePicker: "react-native-image-picker",
  RNCameraManager: "react-native-camera",
  RNCameraModule: "react-native-camera",
  RNPhotoManipulator: "react-native-photo-manipulator",
  RNFileSystem: "react-native-fs",
  RNShareModule: "react-native-share",
  RNPermissions: "react-native-permissions",
  RNVectorIcons: "react-native-vector-icons",
  RNDeviceInfo: "react-native-device-info",
  RNLocalize: "react-native-localize",
  RNKeychainManager: "react-native-keychain",
  RNSecureStorage: "react-native-sensitive-info",
  Restart: "react-native-restart",
  RNCConfig: "react-native-config",
  RNCConfigModule: "react-native-config", // native-module-name variant
  RNGoogleSignin: "@react-native-google-signin/google-signin",
  RNAppleAuthentication: "@invertase/react-native-apple-authentication",
  RNBiometrics: "react-native-biometrics",
  ReactNativeBiometrics: "react-native-biometrics", // the package's actual Android getName(); RNBiometrics above is kept alongside in case another platform/version uses it
  NotifeeApiModule: "@notifee/react-native",
  A0Auth0: "react-native-auth0",
  RNEdgeToEdge: "react-native-edge-to-edge",
  RNRandomBytes: "react-native-randombytes",
  RNHapticFeedback: "react-native-haptic-feedback",
  RNOrientation: "react-native-orientation-locker",
  RNScreenshotPrevent: "react-native-screenshot-prevent",
  RNSplashScreen: "react-native-splash-screen",
  RNBootSplash: "react-native-bootsplash",
  RNCookieManagerAndroid: "@react-native-cookies/cookies",
  RNCookieManagerIOS: "@react-native-cookies/cookies",
  RNCalendarEvents: "react-native-calendar-events",
  RNContacts: "react-native-contacts",
  RNInAppBrowser: "react-native-inappbrowser-reborn",
  RNMapsAirModule: "react-native-maps",
  AIRMapManager: "react-native-maps",
  RNGoogleMobileAdsModule: "react-native-google-mobile-ads",
  RNFBAppModule: "@react-native-firebase/app",
  RNFBAnalyticsModule: "@react-native-firebase/analytics",
  RNFBMessagingModule: "@react-native-firebase/messaging",
  RNFBCrashlyticsModule: "@react-native-firebase/crashlytics",
  RNFBAuthModule: "@react-native-firebase/auth",
  RNFBFirestoreModule: "@react-native-firebase/firestore",
  RNFBRemoteConfigModule: "@react-native-firebase/remote-config",
  RNFirebase: "react-native-firebase", // pre-v6 monolithic package

  // Payments / analytics / monitoring / auth SDKs — high-value, near-unique
  // native-module names (worth the guess-stage weight even with a small map).
  StripeSdk: "@stripe/stripe-react-native",
  RNPaymentsStripeModule: "@stripe/stripe-react-native",
  RNBraintree: "react-native-braintree-dropin-ui",
  RNSentry: "@sentry/react-native",
  RNAnalytics: "@segment/analytics-react-native",
  RNAmplitude: "@amplitude/react-native",
  IntercomModule: "react-native-intercom",
  RNBranch: "react-native-branch",
  RNAppsFlyer: "react-native-appsflyer",
  RNAdjust: "react-native-adjust",
  RNCodePush: "react-native-code-push",
  RNFusedLocation: "react-native-geolocation-service",
  RNWorklets: "react-native-worklets",
  RNShareMenu: "react-native-share-menu",
  RNCallKeep: "react-native-callkeep",
  RNVoipPushNotification: "react-native-voip-push-notification",

  // Storage / state / db.
  RealmModule: "realm",
  SQLite: "react-native-sqlite-storage",
  RNCloudFs: "react-native-cloud-fs",

  // WebRTC / networking.
  WebRTCModule: "react-native-webrtc",
  RNFetchBlob: "rn-fetch-blob",
  RNBlobUtil: "react-native-blob-util",

  // Hermes/RN core itself — a "native module" style hit worth surfacing but
  // not a third-party dependency to report as `require()`.
  DevSettings: "react-native",
  PlatformConstants: "react-native",
  Timing: "react-native",
  SourceCode: "react-native",

  // Expo SDK: a whole ecosystem and a very common RN toolchain. Each name
  // below is a string passed to a call shape that names a real native module,
  // co-located in the same (small, easy-to-read) factory function as a
  // `requireNativeModule`/`requireOptionalNativeModule`/
  // `requireNativeViewManager` call — not just a string that happens to
  // match, but a string passed to exactly the call shape that names a real
  // native module — and each is independently verifiable against the named
  // package's own public source (some, like `ExponentConstants`, keep the
  // pre-rename "Exponent" prefix from Expo's old package name).
  ExpoFetchModule: "expo",
  ExpoAsset: "expo-asset",
  ExpoBlurView: "expo-blur",
  ExpoBlurTargetView: "expo-blur", // the view-manager name alongside ExpoBlurView, same module
  ExponentConstants: "expo-constants",
  ExpoFontLoader: "expo-font",
  ExpoFontUtils: "expo-font",
  ExpoLinking: "expo-linking",
  ExpoSplashScreen: "expo-splash-screen",
  }),
);

/**
 * Heuristic fallback for a native-module name not in the curated map: strip
 * common `RN`/`RNC`/`RCT` prefixes and `Module`/`Manager` suffixes, then
 * hyphenate into an `react-native-<name>`-shaped guess — used only to seed an
 * npm registry search query (D17a), never emitted directly as a confident
 * candidate.
 */
export function guessPackageNameFromNativeModule(name: string): string | null {
  let n = name;
  for (const prefix of ["RNC", "RCT", "RN"]) {
    if (n.startsWith(prefix) && n.length > prefix.length && n[prefix.length] === n[prefix.length]!.toUpperCase()) {
      n = n.slice(prefix.length);
      break;
    }
  }
  for (const suffix of ["Module", "Manager", "View", "Native"]) {
    if (n.endsWith(suffix) && n.length > suffix.length) {
      n = n.slice(0, -suffix.length);
      break;
    }
  }
  if (n.length === 0) return null;
  const hyphenated = n
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
  return `react-native-${hyphenated}`;
}
