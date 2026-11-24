#!/usr/bin/env node
// Regenerates src/export/rn-compat.json: per npm package, (a) which versions
// declare which `react-native` peer range (one row per distinct range: the newest
// version carrying it) and (b) a month-thinned publish timeline, plus the release
// date of each React Native minor line. `hbc2js export` uses it to pin name-only
// bare-RN dependencies (detected from a native-module string, version unknown) to
// "the newest version whose react-native peer range admits the detected RN",
// else "the newest version published by that RN minor's last patch release".
//
// Source: the public npm registry packuments (`https://registry.npmjs.org/<pkg>`),
// i.e. exactly what `npm view <pkg> versions peerDependencies time --json` reads.
// Usage: node tools/gen-rn-compat.mjs        (needs network, Node >= 22.18)
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_MODULE_TO_PACKAGE } from "../src/deps/native-modules.ts";

const EXTRA = [
  "react-native-vector-icons", "react-native-reanimated", "react-native-worklets", "react-native-mmkv", "react-native-linear-gradient",
  "react-native-pager-view", "react-native-modal", "react-native-toast-message", "react-native-get-random-values", "react-native-url-polyfill",
  "react-native-quick-crypto", "react-native-fast-image", "react-native-gifted-chat", "react-native-draggable-flatlist", "react-native-element-dropdown",
  "react-native-svg-transformer", "react-native-tab-view", "react-native-snap-carousel", "react-native-image-crop-picker", "react-native-document-picker",
  "react-native-device-info", "react-native-qrcode-svg", "react-native-camera-kit", "react-native-vision-camera", "react-native-nfc-manager",
  "react-native-ble-plx", "react-native-keyboard-controller", "react-native-reanimated-carousel", "react-native-bootsplash", "react-native-flash-message",
  "react-native-biometrics", "react-native-tcp-socket", "react-native-udp", "react-native-level-fs", "react-native-randombytes",
  "@react-native-community/cli", "@shopify/flash-list", "@shopify/react-native-skia", "@gorhom/bottom-sheet", "@react-native-picker/picker",
  "@react-native-community/blur", "@react-native-community/geolocation", "@react-native-firebase/app", "@react-navigation/native", "@react-navigation/stack",
  "@react-navigation/bottom-tabs", "@react-navigation/native-stack", "@react-navigation/drawer", "@react-navigation/elements",
  "@sentry/react-native", "@notifee/react-native", "@bugsnag/react-native", "@lodev09/react-native-true-sheet",
];
const names = [...new Set([...NATIVE_MODULE_TO_PACKAGE.values(), ...EXTRA])].filter((n) => n !== "react-native" && !n.startsWith("expo")).sort();

const STABLE = /^\d+\.\d+\.\d+$/;
const cmp = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

async function packument(name) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}`);
    if (res.status === 404) return null;
    if (res.ok) return res.json();
  }
  throw new Error(`fetch ${name} failed`);
}

const rnDoc = await packument("react-native");
const rn = {};
for (const [v, t] of Object.entries(rnDoc.time)) {
  if (!STABLE.test(v)) continue;
  const minor = v.split(".").slice(0, 2).join(".");
  if (rn[minor] === undefined || t > rn[minor]) rn[minor] = t.slice(0, 10);
}

const packages = {};
let next = 0;
async function worker() {
  while (next < names.length) {
    const name = names[next++];
    const doc = await packument(name);
    if (doc === null) continue;
    const versions = Object.keys(doc.versions).filter((v) => STABLE.test(v)).sort(cmp);
    const byRange = new Map();
    for (const v of versions) {
      const range = doc.versions[v].peerDependencies?.["react-native"];
      if (range !== undefined) byRange.set(range, v); // ascending: the newest version carrying each range wins
    }
    const months = new Map();
    for (const v of versions) {
      const t = doc.time?.[v];
      if (t !== undefined) months.set(t.slice(0, 7), v);
    }
    packages[name] = {
      peers: [...byRange].map(([range, v]) => [v, range]).sort((a, b) => cmp(a[0], b[0])),
      months: [...months].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    };
  }
}
await Promise.all(Array.from({ length: 6 }, worker));

const sorted = Object.fromEntries(Object.entries(packages).sort(([a], [b]) => (a < b ? -1 : 1)));
const body = { generatedOn: new Date().toISOString().slice(0, 10), source: "registry.npmjs.org packuments (peerDependencies, time)", sha256: createHash("sha256").update(JSON.stringify([rn, sorted])).digest("hex"), rn, packages: sorted };
const dest = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "export", "rn-compat.json");
writeFileSync(dest, `${JSON.stringify(body)}\n`);
console.log(`wrote ${dest}: ${Object.keys(sorted).length} packages of ${names.length}`);
