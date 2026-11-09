// Regression for docs/BUGS.md 2026-11-10 "slot poisoning": a job that mutates
// its scaffold slot (here: deletes a dependency, rewrites a lockfile in place)
// must not leave the next job's slot damaged. Offline, tiny fake scaffold.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(fileURLToPath(new URL(".", import.meta.url)), "../../../tools/pkgsig/bulk/slot-reset.sh");
const sh = (cmd: string) => execFileSync("bash", ["-c", `. '${SCRIPT}'; ${cmd}`], { encoding: "utf8" });

test("worker slot reset: the next job's slot is pristine after a job deleted a scaffold dependency (bugs-2026-11-10 slot poisoning)", () => {
    const root = mkdtempSync(join(tmpdir(), "slotreset-"));
    try {
      const pristine = join(root, "Pristine72");
      const slot = join(root, "slots", "72-1");
      mkdirSync(join(pristine, "node_modules/@react-native-community/cli"), { recursive: true });
      mkdirSync(join(root, "slots"), { recursive: true });
      writeFileSync(join(pristine, "node_modules/@react-native-community/cli/index.js"), "cli");
      writeFileSync(join(pristine, "package.json"), '{"a":1}');
      writeFileSync(join(pristine, "package-lock.json"), "lock0");
      writeFileSync(join(pristine, "node_modules/.package-lock.json"), "hidden0");

      sh(`reset_slot '${pristine}' '${slot}'`);
      // simulated poisoning install: delete a dep, add residue, rewrite lockfiles IN PLACE
      rmSync(join(slot, "node_modules/@react-native-community"), { recursive: true });
      mkdirSync(join(slot, "node_modules/residue"));
      sh(`echo mutated > '${slot}/package-lock.json'; echo mutated > '${slot}/package.json'; echo mutated > '${slot}/node_modules/.package-lock.json'`);

      sh(`reset_slot '${pristine}' '${slot}'`);
      assert.equal(readFileSync(join(slot, "node_modules/@react-native-community/cli/index.js"), "utf8"), "cli");
      assert.equal(existsSync(join(slot, "node_modules/residue")), false);
      assert.equal(readFileSync(join(slot, "package-lock.json"), "utf8"), "lock0");
      assert.equal(readFileSync(join(slot, "package.json"), "utf8"), '{"a":1}');
      assert.equal(readFileSync(join(slot, "node_modules/.package-lock.json"), "utf8"), "hidden0");
      // and the pristine copy itself was never touched
      assert.equal(readFileSync(join(pristine, "package-lock.json"), "utf8"), "lock0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
