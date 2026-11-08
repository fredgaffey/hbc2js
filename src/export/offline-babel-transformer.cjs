// Offline bundling check only (spec 29 §4.6): a Metro `babelTransformerPath`
// that transforms with the INSTALLED toolchain (`@react-native/babel-preset`
// of this repo's pinned React Native), ignoring the exported tree's own
// babel.config.js. The tree keeps the original app's toolchain names; only
// the check is redirected. The installed transformer falls back to its own
// preset when `projectRoot` holds no babel config, so we hand it an empty one.
"use strict";
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const upstream = require("@react-native/metro-babel-transformer");

let emptyRoot = null;
module.exports = {
  ...upstream,
  transform(args) {
    emptyRoot ??= mkdtempSync(join(tmpdir(), "hbc2js-offline-babel-"));
    return upstream.transform({ ...args, options: { ...args.options, projectRoot: emptyRoot } });
  },
};
