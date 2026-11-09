// Regression for docs/BUGS.md 2026-11-10 "slot poisoning": a job that mutates
// its scaffold slot (here: deletes a dependency, rewrites a lockfile in place)
// must not leave the next job's slot damaged. Offline, tiny fake scaffold.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(__dirname, "../../../tools/pkgsig/bulk/slot-reset.sh");
const sh = (cmd: string) => execFileSync("bash", ["-c", `. '${SCRIPT}'; ${cmd}`], { encoding: "utf8" });

describe("worker slot reset (bugs-2026-11-10 slot poisoning)", () => {
  it("the next job's slot is pristine after a job deleted a scaffold dependency", () => {
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
      expect(readFileSync(join(slot, "node_modules/@react-native-community/cli/index.js"), "utf8")).toBe("cli");
      expect(existsSync(join(slot, "node_modules/residue"))).toBe(false);
      expect(readFileSync(join(slot, "package-lock.json"), "utf8")).toBe("lock0");
      expect(readFileSync(join(slot, "package.json"), "utf8")).toBe('{"a":1}');
      expect(readFileSync(join(slot, "node_modules/.package-lock.json"), "utf8")).toBe("hidden0");
      // and the pristine copy itself was never touched
      expect(readFileSync(join(pristine, "package-lock.json"), "utf8")).toBe("lock0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
