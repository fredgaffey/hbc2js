#!/usr/bin/env node
// Regenerates src/export/expo-bundled-modules.json from the `bundledNativeModules.json`
// each Expo SDK's `expo` package ships (package name -> compatible range).
// Usage: node tools/gen-expo-bundled-modules.mjs   (needs network + npm + tar)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PINS = { 50: "50.0.21", 51: "51.0.39", 52: "52.0.49", 53: "53.0.27", 54: "54.0.38", 55: "55.0.32" };
const out = {};
for (const [sdk, ver] of Object.entries(PINS)) {
  const dir = mkdtempSync(join(tmpdir(), "expo-pack-"));
  const tgz = execFileSync("npm", ["pack", `expo@${ver}`, "--silent"], { cwd: dir, encoding: "utf8" }).trim().split("\n").pop();
  execFileSync("tar", ["-xzf", tgz, "package/bundledNativeModules.json"], { cwd: dir });
  const bytes = readFileSync(join(dir, "package", "bundledNativeModules.json"));
  out[sdk] = { expoVersion: ver, sha256: createHash("sha256").update(bytes).digest("hex"), modules: JSON.parse(bytes.toString("utf8")) };
}
const dest = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "export", "expo-bundled-modules.json");
writeFileSync(dest, `${JSON.stringify(out, null, 1)}\n`);
console.log(`wrote ${dest}`);
