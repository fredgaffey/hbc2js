// Native-module hint registry entries (`NATIVE_MODULE_TO_PACKAGE`,
// src/deps/native-modules.ts): curated name -> package entries, each independently verifiable against the named package's own public
// source, same as every other entry in this file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NATIVE_MODULE_TO_PACKAGE } from "../../../src/deps/native-modules.ts";

test("lottie-react-native's native-module name is registered", () => {
  assert.equal(NATIVE_MODULE_TO_PACKAGE.get("LottieAnimationView"), "lottie-react-native");
});

test("react-native-biometrics: both the real name and the alternative name resolve to the same package", () => {
  // ReactNativeBiometrics is the package's real Android getName(); RNBiometrics
  // is kept alongside in case another platform/version uses it.
  assert.equal(NATIVE_MODULE_TO_PACKAGE.get("ReactNativeBiometrics"), "react-native-biometrics");
  assert.equal(NATIVE_MODULE_TO_PACKAGE.get("RNBiometrics"), "react-native-biometrics");
});

test("every listed entry resolves to its documented package", () => {
  const added: ReadonlyArray<readonly [string, string]> = [
    ["LottieAnimationView", "lottie-react-native"],
    ["ReactNativeBiometrics", "react-native-biometrics"],
    ["NotifeeApiModule", "@notifee/react-native"],
    ["A0Auth0", "react-native-auth0"],
    ["RNEdgeToEdge", "react-native-edge-to-edge"],
    ["RNRandomBytes", "react-native-randombytes"],
    ["RNCSafeAreaContext", "react-native-safe-area-context"],
    ["RNCWebViewModule", "react-native-webview"],
    ["RNCConfigModule", "react-native-config"],
    ["RNDatePicker", "@react-native-community/datetimepicker"],
    ["RNGestureHandlerButton", "react-native-gesture-handler"],
    ["RNGestureHandlerRootView", "react-native-gesture-handler"],
    ["RNSModalScreen", "react-native-screens"],
    ["RNSModule", "react-native-screens"],
    ["RNSSafeAreaView", "react-native-screens"],
    ["RNSStackHost", "react-native-screens"],
    ["RNSStackScreen", "react-native-screens"],
    ["RNSTabsHost", "react-native-screens"],
    ["RNSTabsScreen", "react-native-screens"],
    ["RNSScreenStackHeaderConfig", "react-native-screens"],
    ["RNSScreenStackHeaderSubview", "react-native-screens"],
    ["RNSVGSvgViewAndroid", "react-native-svg"],
    ["RNSVGSvgViewModule", "react-native-svg"],
    ["ImageResizer", "react-native-image-resizer"],
  ];
  for (const [name, pkg] of added) {
    assert.equal(NATIVE_MODULE_TO_PACKAGE.get(name), pkg, `${name} should map to ${pkg}`);
  }
});

test("registry has no entry for a bare Object.prototype member name (untrusted-input safety, unchanged by the audit)", () => {
  assert.equal(NATIVE_MODULE_TO_PACKAGE.get("hasOwnProperty"), undefined);
  assert.equal(NATIVE_MODULE_TO_PACKAGE.get("toString"), undefined);
  assert.equal(NATIVE_MODULE_TO_PACKAGE.get("constructor"), undefined);
});

test("Expo SDK native-module names, found missing entirely -- observed live in tests/fixtures/bundles/react-navigation-example-0.85.3's release .hbc, each paired with a requireNativeModule/requireOptionalNativeModule/requireNativeViewManager call in the same factory function, and independently verifiable against each package's own public source", () => {
  const added: ReadonlyArray<readonly [string, string]> = [
    ["ExpoFetchModule", "expo"],
    ["ExpoAsset", "expo-asset"],
    ["ExpoBlurView", "expo-blur"],
    ["ExpoBlurTargetView", "expo-blur"],
    ["ExponentConstants", "expo-constants"],
    ["ExpoFontLoader", "expo-font"],
    ["ExpoFontUtils", "expo-font"],
    ["ExpoLinking", "expo-linking"],
    ["ExpoSplashScreen", "expo-splash-screen"],
  ];
  for (const [name, pkg] of added) {
    assert.equal(NATIVE_MODULE_TO_PACKAGE.get(name), pkg, `${name} should map to ${pkg}`);
  }
});
