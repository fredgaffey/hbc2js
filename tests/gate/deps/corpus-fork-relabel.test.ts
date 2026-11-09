// corpus-fork-relabel (docs/DEPS.md "Fork relabel"): an app that ships a fork
// or rename Q of an upstream package P matches P's signature, while the truth
// names Q. When the bundle's own strings name Q as a package, Q is a fork
// relative of P by a structural rule, and nothing names P itself, the
// confirmed package is reported as Q with `forkOf: P`. Synthetic fixtures:
// only the module string tables and the scored package list matter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { relabelForks } from "../../../src/deps/fork-relabel.ts";
import { buildReport } from "../../../src/deps/report.ts";
import type { MatchReport, PackageScore } from "../../../src/deps/match.ts";

const score = (pkg: string, tier: PackageScore["tier"] = "high"): PackageScore => ({
  package: pkg, version: "1.0.0", hbcVersion: 96, layer: "shared", isBaseline: false, eligibleFunctions: 20, exactHits: 18, fuzzyOnlyHits: 0, stringCorroborated: 0,
  exactCoverage: 0.9, fuzzyCoverage: 0.9, moduleExactHits: 3, moduleTotal: 3, tier,
});
const inv = (...modules: readonly (readonly string[])[]) => ({ modules: modules.map((stringConstants) => ({ stringConstants })) });
const MANIFEST = ["name", "version", "dependencies", "description"];
const forkOf = (out: readonly PackageScore[], pkg: string): string | undefined => out.find((p) => p.package === pkg)?.fork?.package;
const none: ReadonlySet<string> = new Set();

test("corpus-fork-relabel: an unscoped package named only under a scope is the scoped copy (@metamask/superstruct)", () => {
  const out = relabelForks([score("superstruct")], inv(["Assertion failed", "@metamask/superstruct"], ["superstruct.sensitive"]), none);
  assert.equal(forkOf(out, "superstruct"), "@metamask/superstruct");
  assert.equal(out[0]!.fork!.rule, "scoped-copy");
  assert.ok(out[0]!.fork!.evidence.some((e) => e.includes("@metamask/superstruct")));
});

test("corpus-fork-relabel: a scoped package moved to its own scope (@react-native-community/cookies -> @react-native-cookies/cookies)", () => {
  const out = relabelForks([score("@react-native-community/cookies")], inv(["@react-native-community/cookies: Import libraries to android"], [...MANIFEST, "@react-native-cookies/cookies"]), none);
  assert.equal(forkOf(out, "@react-native-community/cookies"), "@react-native-cookies/cookies");
  assert.equal(out[0]!.fork!.rule, "own-scope");
});

test("corpus-fork-relabel: the same generic basename under an unrelated scope is not a fork (@babel/core vs @sentry/core)", () => {
  const out = relabelForks([score("@babel/core")], inv(["@sentry/core"]), none);
  assert.equal(forkOf(out, "@babel/core"), undefined);
});

test("corpus-fork-relabel: a suffixed fork named beside the upstream in one small manifest (whatwg-url -> whatwg-url-without-unicode)", () => {
  const out = relabelForks([score("whatwg-url"), score("react-native")], inv([...MANIFEST, "react-native", "whatwg-url", "whatwg-url-without-unicode"]), none);
  assert.equal(forkOf(out, "whatwg-url"), "whatwg-url-without-unicode");
  assert.equal(out[0]!.fork!.rule, "affix");
});

test("corpus-fork-relabel: a suffixed package named by a dependent's manifest is the original of a -js fork (source-map-js -> source-map)", () => {
  const out = relabelForks([score("source-map-js")], inv([...MANIFEST, "css-tree", "mdn-data", "source-map", "^0.6.1"]), none);
  assert.equal(forkOf(out, "source-map-js"), "source-map");
});

test("corpus-fork-relabel: a bare word is never the counterpart (readable-stream vs \"readable\")", () => {
  const out = relabelForks([score("readable-stream")], inv(["readable", "end"]), none);
  assert.equal(forkOf(out, "readable-stream"), undefined);
});

test("corpus-fork-relabel: the upstream named on its own elsewhere keeps the upstream", () => {
  const out = relabelForks([score("superstruct")], inv(["@metamask/superstruct"], ["superstruct", "validateStruct"]), none);
  assert.equal(forkOf(out, "superstruct"), undefined);
});

test("corpus-fork-relabel: a counterpart that is confirmed itself is left to the twin rules", () => {
  const out = relabelForks([score("react-query"), score("@tanstack/react-query")], inv(["@tanstack/react-query"]), none);
  assert.equal(forkOf(out, "react-query"), undefined);
});

test("corpus-fork-relabel: a scoped copy with an unmatched signature is still the fork; an affix counterpart with a signature is not", () => {
  const sigs = new Set(["@tanstack/react-query", "whatwg-url-without-unicode"]);
  const out = relabelForks([score("react-query"), score("whatwg-url"), score("@tanstack/react-query", "medium")], inv(["@tanstack/react-query"], [...MANIFEST, "whatwg-url-without-unicode"]), sigs);
  assert.equal(forkOf(out, "react-query"), "@tanstack/react-query");
  assert.equal(forkOf(out, "whatwg-url"), undefined);
});

test("corpus-fork-relabel: an app manifest naming the package, a suffixed plugin and many other confirmed packages keeps the package", () => {
  const others = ["react", "react-native", "lodash", "redux", "axios", "immer"];
  const out = relabelForks([score("react-native-reanimated"), ...others.map((o) => score(o))], inv([...MANIFEST, ...others, "react-native-reanimated", "react-native-reanimated-carousel"]), none);
  assert.equal(forkOf(out, "react-native-reanimated"), undefined);
});

test("corpus-fork-relabel: two counterparts are ambiguous; @types is never a fork", () => {
  assert.equal(forkOf(relabelForks([score("superstruct")], inv(["@metamask/superstruct", "@acme/superstruct"]), none), "superstruct"), undefined);
  assert.equal(forkOf(relabelForks([score("events")], inv(["@types/events"]), none), "events"), undefined);
});

test("corpus-fork-relabel: the report names the fork, with forkOf the upstream it matched", () => {
  const packages = relabelForks([score("superstruct"), score("@metamask/utils")], inv(["@metamask/superstruct"]), none);
  const mr: MatchReport = { hbcVersion: 96, totalFunctions: 0, totalModules: 1, packagesChecked: 2, packages, moduleAttributions: [], unattributedModules: [] };
  const deps = buildReport("fixture.hbc", mr, []).confirmedDeps;
  const d = deps.find((x) => x.package === "@metamask/superstruct");
  assert.ok(d !== undefined, JSON.stringify(deps.map((x) => x.package)));
  assert.equal(d!.forkOf, "superstruct");
  assert.equal(deps.some((x) => x.package === "superstruct"), false);
});
