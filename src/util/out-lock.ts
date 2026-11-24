// A lock for a command that writes one output directory (`hbc2js export
// --out <dir>`): two runs into the same directory would interleave their
// writes, so the second fails fast instead. The lock is a sibling file
// (`<dir>.hbc2js.lock`), never inside the tree itself (the tree must stay
// exactly the export's files, and an empty-directory check runs on it). A
// lock whose recorded pid is no longer running (a killed run) is stale and
// taken over.
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { hostname } from "node:os";

export interface OutLock {
  readonly path: string;
  release(): void;
}

export class OutLockHeldError extends Error {}

export function lockPathFor(outDir: string): string {
  return `${resolve(outDir).replace(/[/\\]+$/, "")}.hbc2js.lock`;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Takes the lock for `outDir`, or throws `OutLockHeldError` naming the
 *  holder. Released by `release()` and, as a fallback, at process exit. */
export function acquireOutLock(outDir: string, verb: string): OutLock {
  const path = lockPathFor(outDir);
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = openSync(path, "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let holder: { pid?: number; host?: string } = {};
      try {
        holder = JSON.parse(readFileSync(path, "utf8")) as typeof holder;
      } catch {
        // Unreadable or half-written: treat as held unless it stays that way.
      }
      const sameHost = holder.host === undefined || holder.host === hostname();
      if (attempt === 0 && typeof holder.pid === "number" && sameHost && !alive(holder.pid)) {
        rmSync(path, { force: true });
        continue;
      }
      throw new OutLockHeldError(
        `another ${verb} (pid ${holder.pid ?? "unknown"}${sameHost ? "" : ` on ${holder.host}`}) is writing ${resolve(outDir)}; wait for it to finish, or delete ${path} if that run is gone`,
      );
    }
    writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), verb, started: new Date().toISOString() }));
    closeSync(fd);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      process.off("exit", release);
      rmSync(path, { force: true });
    };
    process.on("exit", release);
    return { path, release };
  }
  throw new OutLockHeldError(`could not take the lock ${path}`);
}
