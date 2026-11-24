#!/usr/bin/env node
// Report free (undeclared, non-global) identifiers in every .js file under a
// directory -- e.g. an `hbc2js export` project tree. Usage:
//   node tools/export-check/free-idents.mjs <dir> [--json] [--verbose]
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "@babel/parser";
import traverseMod from "@babel/traverse";
const traverse = traverseMod.default ?? traverseMod;

// Host/RN globals legitimately referenced without a declaration.
const HOST = new Set([
  "require", "module", "exports", "global", "globalThis", "__DEV__", "console",
  "window", "self", "process", "__dirname", "__filename", "arguments",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate",
  "clearImmediate", "queueMicrotask", "requestAnimationFrame", "cancelAnimationFrame",
  "fetch", "XMLHttpRequest", "FormData", "Headers", "Request", "Response", "URL",
  "URLSearchParams", "AbortController", "AbortSignal", "Blob", "FileReader",
  "TextEncoder", "TextDecoder", "WebSocket", "performance", "navigator", "location",
  "nativeFabricUIManager", "HermesInternal", "__fbBatchedBridgeConfig", "__r", "__d",
  "nativeModuleProxy", "__turboModuleProxy", "RN$Bridgeless", "atob", "btoa",
  "structuredClone", "Event", "EventTarget", "DOMException", "crypto", "document",
  "print", // the Hermes CLI host (fixtures run under `hermes`)
]);
const isGlobal = (n) => HOST.has(n) || n in globalThis;

export function freeIdentifiers(code) {
  const ast = parse(code, {
    sourceType: "unambiguous", errorRecovery: true,
    plugins: ["jsx", "classProperties", "classPrivateProperties", "classPrivateMethods"],
  });
  const out = new Map();
  traverse(ast, {
    Program(path) {
      for (const [name, node] of Object.entries(path.scope.globals)) {
        if (isGlobal(name)) continue;
        out.set(name, node.loc?.start.line ?? 0);
      }
      // typeof x of an undeclared name is legal and never throws; drop those.
      path.traverse({
        UnaryExpression(p) {
          if (p.node.operator === "typeof" && p.node.argument.type === "Identifier") {
            const n = p.node.argument.name;
            if (out.has(n) && !p.scope.hasBinding(n)) out.set(n, -1e9);
          }
        },
      });
    },
  });
  for (const [k, v] of out) if (v < 0) out.delete(k);
  return [...out.keys()].sort();
}

/** Like freeIdentifiers but returns `name@line` (first reference). */
export function freeIdentifiersWithLines(code) {
  const names = freeIdentifiers(code);
  const ast = parse(code, { sourceType: "unambiguous", errorRecovery: true, plugins: ["jsx"] });
  let g = {};
  traverse(ast, { Program(p) { g = p.scope.globals; } });
  return names.map((n) => `${n}@${g[n]?.loc?.start.line ?? "?"}`);
}

function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (e.endsWith(".js")) acc.push(p);
  }
  return acc;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  const json = process.argv.includes("--json");
  const verbose = process.argv.includes("--verbose");
  const files = {}; let total = 0; let parseErr = 0;
  for (const f of walk(dir)) {
    let names;
    try { names = (verbose ? freeIdentifiersWithLines : freeIdentifiers)(readFileSync(f, "utf8")); } catch (e) { parseErr++; continue; }
    if (names.length) { files[relative(dir, f)] = names; total += names.length; }
  }
  const summary = { files: Object.keys(files).length, identifiers: total, parseErrors: parseErr };
  if (json) console.log(JSON.stringify({ summary, files }, null, 2));
  else {
    console.log(JSON.stringify(summary));
    if (verbose) for (const [f, n] of Object.entries(files)) console.log(f + ": " + n.join(" "));
  }
}
