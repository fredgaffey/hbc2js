// corpus-residual-fp (docs/DEPS.md "Residual offline false positives on
// J3"): on Expensify with module paths, the largest remaining false-positive
// mechanism is GENERIC code — a signature function or module factory whose
// exact hash the target holds many times over, in unrelated modules:
// ES-module boilerplate factories (`lodash-es`, `culori`, `swiper`, `uuid`
// match tiny app modules of the same shape) and transpiler helpers inlined
// into single-file dist bundles (`axios`, `ai`, `keyv`, `ocache`). Such a
// hash is not evidence for any one package: the DB-side ambiguity check
// misses it because only the candidate packages are loaded. Matching now
// ignores an exact hash the target holds TARGET_GENERIC_COPIES or more
// times.
//
// Synthetic: `tiny-boiler`'s three modules share one boilerplate shape the
// app also uses in four of its own modules; `tiny-real` has three distinct
// modules, one of them duplicated in the app (two installed copies).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireHermesc } from "../../support/hermesc.ts";
import { buildInventory } from "../../../src/deps/inventory.ts";
import { matchInventory, TARGET_GENERIC_COPIES } from "../../../src/deps/match.ts";
import { fingerprintModule, SIG_HASH_SCHEME } from "../../../src/deps/fingerprint.ts";
import { decodeFunction } from "../../../src/disasm/decode.ts";
import { parseHbc } from "../../../src/parse/module.ts";
import type { LoadedSig } from "../../../src/deps/db.ts";
import type { SigDbFile } from "../../../src/deps/sigdb-types.ts";

const HEAD = "function __d(factory, moduleId, deps) {}";
const FN = "function (global, require, importDefault, exportAll, module, exports, dependencyMap)";
// One boilerplate shape (an ESM re-export factory with an interop helper).
const BOILER = `{ Object.defineProperty(exports, "__esModule", { value: true }); var _x = require(dependencyMap[0]); function _interop(o) { return o && o.__esModule ? o : { default: o }; } var _y = _interop(_x); exports.default = _y.default; }`;
const R0 = `{ var t = 0; for (var i = 0; i < 37; i++) { t = t + i * 3 - (i % 5) + (i > 10 ? 2 : 1); } module.exports = function sumReal(x) { return t + x * 7 - (x % 3); }; }`;
const R1 = `{ var s = ""; for (var j = 0; j < 29; j++) { s = s + String.fromCharCode(65 + (j % 26)); } module.exports = function strReal(n) { return s.slice(n % 5) + s.length * n; }; }`;
const R2 = `{ var a = []; for (var k = 0; k < 41; k++) { a.push(k * k - k + 7, k + 1); } module.exports = function arrReal(q) { return a[q % a.length] * 2 + a.length - q; }; }`;
const APP = `{ var c = 1; for (var w = 0; w < 19; w++) { c = (c * 31 + w) % 1000003; } module.exports = function appOnly(v) { return c ^ v; }; }`;

const bundle = (bodies: readonly string[]): string => [HEAD, ...bodies.map((b, id) => `__d(${FN}${b},${id},[]);`)].join("\n") + "\n";

function compile(hermesc: string, js: string): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-residual-"));
  try {
    execFileSync(hermesc, ["-O", "-emit-binary", `-out=${join(dir, "o.hbc")}`, "-"], { input: js });
    return new Uint8Array(readFileSync(join(dir, "o.hbc")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function signature(hermesc: string, pkg: string, bodies: readonly string[]): SigDbFile {
  const mod = parseHbc(compile(hermesc, bundle(bodies)));
  const fp = fingerprintModule(mod, decodeFunction);
  const modules = fp.modules.map(({ nestedFunctionIndices: _n, ...m }) => m);
  return {
    schema: 2, hashScheme: SIG_HASH_SCHEME, package: pkg, version: "1.0.0", hbcVersion: mod.header.version,
    totalFunctions: fp.functions.length, rawFunctionCount: fp.functions.length, subtractedBaselines: [], functions: fp.functions, modules, toolchainBaseline: false,
    provenance: { packageSha256: null, metroVersion: null, reactNativeVersion: null, hermescVersion: mod.header.version, hermescRnEra: null, repoCommit: null, builtAt: "2026-11-09T00:00:00.000Z" },
  };
}

const loaded = (files: readonly SigDbFile[]): LoadedSig[] => files.map((file) => ({ file, layer: "shared", path: `<${file.package}>` }));

test("corpus-residual-fp: a hash the target holds many times is generic — boilerplate never lifts a package; real duplicated code still counts", (t) => {
  const h = requireHermesc(t, 96);
  if (h === null) return;
  const boiler = signature(h.path, "tiny-boiler", [BOILER, BOILER, BOILER]);
  const real = signature(h.path, "tiny-real", [R0, R1, R2]);
  // App: seven boilerplate modules of its own (more than twice the three the
  // package holds), tiny-real (R0 twice: two copies), app code.
  const target = buildInventory(compile(h.path, bundle([BOILER, APP, BOILER, R0, R1, BOILER, R2, R0, BOILER, BOILER, BOILER, BOILER]))).inventory;
  const report = matchInventory(target, loaded([boiler, real]));
  const score = (p: string) => report.packages.find((s) => s.package === p);
  assert.notEqual(score("tiny-boiler")?.tier ?? "none", "high", `boilerplate must not reach high: ${JSON.stringify(score("tiny-boiler"))}`);
  assert.equal(score("tiny-boiler")?.moduleExactHits ?? 0, 0, "no module hit on a generic factory");
  assert.equal(score("tiny-real")?.tier, "high", "the real package stays high");
  assert.equal(score("tiny-real")?.moduleExactHits, 3, "a module present twice still counts");
  assert.ok(TARGET_GENERIC_COPIES > 2, "two installed copies of a package are not generic");
  assert.ok(TARGET_GENERIC_COPIES <= 3, "three copies of a shape the package holds once are generic");
});
