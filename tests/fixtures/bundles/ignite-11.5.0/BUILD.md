# ignite-11.5.0 -- build provenance

The Ignite boilerplate demo app (Infinite Red, MIT), tag v11.5.0, commit
a0464bf1337099eb3bb7cbdef54fbcd0ccf94859. An Expo app: react-native 0.83.2,
expo 55.0.5, react 19.2.0, hermes-compiler 0.14.1, Hermes bytecode version 96
(hbc2js --info: layout C / hbc96, 13784 functions).

The binaries are NOT committed (`app.hbc` is ~4.4 MB); `fetch.sh` regenerates
them. Tests that use this fixture skip cleanly when `app.hbc` is absent.

## Commands (cwd = boilerplate/ of the checkout)

    git checkout v11.5.0
    npm install --legacy-peer-deps --ignore-scripts --no-audit --no-fund
    export CI=1 EXPO_NO_TELEMETRY=1
    node_modules/.bin/expo export --platform android --output-dir dist-js --no-bytecode --source-maps
    node_modules/.bin/expo export --platform android --output-dir dist-hbc
    cp dist-hbc/_expo/static/js/android/index-*.hbc app.hbc

Build with Node 24.22.1. No lockfile upstream, so a regenerated `app.hbc` can
differ in transitive versions from the one tests were written against
(sha256 e2845d1d37c175c787ff23073ae620172cc9375bf9ea4f19860956046a82aac5,
4440722 bytes); assertions on this fixture only use the direct-dependency
truth below.

## Truth (direct dependencies, from boilerplate/package.json)

33 dependencies, including react-native 0.83.2, react 19.2.0, expo 55.0.5,
the expo-* modules, @react-navigation/*, react-native-mmkv 3.3.3,
react-native-reanimated 4.2.1, react-native-screens, i18next. `deps-truth.json`
(also gitignored; produced by fetch.sh) holds the list.
