// Offline bundling check only (spec 29 §4.6): a Metro `babelTransformerPath`
// that transforms with the INSTALLED toolchain (the
// `@react-native/metro-babel-transformer` offline-check.ts resolved from the
// export tree's node_modules, passed by absolute path in
// HBC2JS_OFFLINE_BABEL_TRANSFORMER so Metro's workers see it too), ignoring
// the exported tree's own babel.config.js. The tree keeps the original app's toolchain names; only
// the check is redirected. The installed transformer falls back to its own
// preset when `projectRoot` holds no babel config, so we hand it an empty one.
"use strict";
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const upstreamPath = process.env.HBC2JS_OFFLINE_BABEL_TRANSFORMER;
if (!upstreamPath) throw new Error("offline-babel-transformer.cjs: HBC2JS_OFFLINE_BABEL_TRANSFORMER is unset (it is only loaded by hbc2js's offline bundle check)");
const upstream = require(upstreamPath);

let emptyRoot = null;
module.exports = {
  ...upstream,
  transform(args) {
    emptyRoot ??= mkdtempSync(join(tmpdir(), "hbc2js-offline-babel-"));
    return upstream.transform({ ...args, options: { ...args.options, projectRoot: emptyRoot } });
  },
};
