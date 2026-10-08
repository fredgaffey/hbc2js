// tests/gate/export/tree-layout.test.ts — docs/specs/29-export.md §3 (directory
// layout) and §4 (boilerplate). Acceptance test, written with the spec, skipped
// by design until `src/export/index.ts` exists (§9); reconstruction lane queue
// item 6a turns these green.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { requireSweep } from "../../support/tiers.ts";
import { cleanup, exportTo, HELD_OUT, IMPLEMENTED, readPackageJson, RN_TEMPLATE, walk } from "./support.ts";

const SKIP = { skip: IMPLEMENTED ? false : "docs/specs/29-export.md not implemented yet (lane item 6a)" };

/** §3: the files a React Native project needs before `npx react-native bundle`
 *  will look at it at all. */
const REQUIRED_ROOT_FILES = [
  "package.json",
  "app.json",
  "babel.config.js",
  "metro.config.js",
  "index.js",
  "EXPORT.json",
];

test("spec 29 §3: export writes the documented project tree on rn-template", SKIP, () => {
  const { out, run } = exportTo(RN_TEMPLATE);
  try {
    assert.equal(run.status, 0, `export failed: ${run.stderr}`);
    for (const f of REQUIRED_ROOT_FILES) {
      assert.ok(existsSync(join(out, f)), `missing ${f}`);
    }
    assert.ok(existsSync(join(out, "src", "_hbc", "registry.js")), "missing src/_hbc/registry.js");
    const files = walk(out);
    assert.ok(files.some((f) => f.startsWith("src/")), "no src/ modules were written");
    // §4.3: exact pins, never a caret/tilde range.
    const pkg = readPackageJson(out);
    for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
      assert.match(version, /^\d+\.\d+\.\d+/, `dependency ${name} is not an exact pin: ${version}`);
    }
  } finally {
    cleanup(out);
  }
});

test("spec 29 §3.1: export never writes a node_modules directory", SKIP, () => {
  const { out } = exportTo(RN_TEMPLATE);
  try {
    const offending = walk(out).filter((f) => f === "node_modules" || f.startsWith("node_modules/"));
    assert.deepEqual(offending, [], "export wrote into node_modules/, which npm install owns");
  } finally {
    cleanup(out);
  }
});

test("spec 29 §7.3: every emitted .js file parses", SKIP, () => {
  const { out } = exportTo(RN_TEMPLATE);
  try {
    const jsFiles = walk(out).filter((f) => f.endsWith(".js"));
    assert.ok(jsFiles.length > 0, "no .js files emitted");
    for (const f of jsFiles) {
      execFileSync(process.execPath, ["--check", join(out, f)], { stdio: "pipe" });
    }
  } finally {
    cleanup(out);
  }
});

test("spec 29 §4.1/§4.2: index.js boots the registry and app.json names the registered component", SKIP, () => {
  const { out } = exportTo(RN_TEMPLATE);
  try {
    const indexJs = readFileSync(join(out, "index.js"), "utf8");
    const registryAt = indexJs.indexOf("_hbc/registry.js");
    const entryAt = indexJs.indexOf("src/index.js");
    assert.ok(registryAt >= 0, "index.js does not boot the module registry");
    assert.ok(entryAt >= 0, "index.js does not run the entry module");
    assert.ok(registryAt < entryAt, "index.js runs the entry module before the registry exists");

    const appJson = JSON.parse(readFileSync(join(out, "app.json"), "utf8")) as { name?: string };
    const appName = appJson.name;
    assert.ok(typeof appName === "string" && appName.length > 0, "app.json has no name");
    // The name the tree actually registers must be the name the host looks up.
    const registered = walk(out)
      .filter((f) => f.endsWith(".js"))
      .map((f) => readFileSync(join(out, f), "utf8"))
      .some((text) => text.includes(JSON.stringify(appName)));
    assert.ok(registered, `no emitted file mentions app.json's name ${JSON.stringify(appName)}`);
  } finally {
    cleanup(out);
  }
});

test("spec 29 §0: the held-out app exports a complete tree", SKIP, (t) => {
  if (!requireSweep(t)) return;
  const { out, run } = exportTo(HELD_OUT);
  try {
    assert.equal(run.status, 0, `export failed: ${run.stderr}`);
    for (const f of REQUIRED_ROOT_FILES) assert.ok(existsSync(join(out, f)), `missing ${f}`);
    const jsFiles = walk(out).filter((f) => f.endsWith(".js"));
    assert.ok(jsFiles.length > 100, `expected the held-out app's many modules, saw ${jsFiles.length}`);
  } finally {
    cleanup(out);
  }
});
