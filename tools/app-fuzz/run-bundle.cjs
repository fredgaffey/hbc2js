// tools/app-fuzz/run-bundle.cjs — run a Metro bundle of the torture headless
// entry in Node (bundle truth: after Babel/terser, before hermesc). Prints
// the headless JSON line. Usage: node run-bundle.cjs <headless.js.bundle>
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
let last = null;
const ctx = { print: (s) => { last = s; }, console: { log() {}, warn() {}, error() {}, info() {} }, setTimeout, clearTimeout, Promise, queueMicrotask };
ctx.globalThis = ctx; ctx.global = ctx; ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(readFileSync(process.argv[2], "utf8"), ctx, { filename: "bundle.js" });
setTimeout(() => { process.stdout.write((last ?? "NO-OUTPUT") + "\n"); }, 200);
