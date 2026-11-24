// Automatic heap bound for the whole-bundle commands (`hbc2js export`).
//
// A large bundle needs more V8 heap than Node's default (~4 GB): the main
// thread holds the full analysis (every decoded function, every CFG, the env
// graph) plus the whole-bundle split, about 250 bytes of heap per bundle byte
// (a 45 MB / 99k-function bundle OOMed at the default during "splitting the
// bundle"). Rather than make every user find `--max-old-space-size`, the CLI
// re-runs itself once with a limit sized from the bundle, capped at 75% of
// physical memory. Never when the user already chose a limit
// (`--max-old-space-size` in the node flags or NODE_OPTIONS), never when the
// default already suffices, and `HBC2JS_HEAP_REEXEC=0` turns it off.
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { constants, totalmem } from "node:os";
import { getHeapStatistics } from "node:v8";

const HEAP_BYTES_PER_BUNDLE_BYTE = 250;
/** `equiv --boot <original> <export-dir>` holds the original's whole-bundle
 *  decompile (as export does) plus both boot traces and their projections; the
 *  0.1.2 corpus a02 (10.4 MB, 48.7k functions) OOMed at Node's default ~4 GB
 *  heap 180 s in, so the boot harness plans for about 3x export's share. */
export const BOOT_HEAP_BYTES_PER_BUNDLE_BYTE = 800;
const MEMORY_SHARE = 0.75;
const MARKER = "HBC2JS_HEAP_REEXEC";

/** The heap limit (MB) to re-run with, or null to run in this process. */
export function heapLimitFor(bundleBytes: number, currentLimitMb: number, totalMemBytes: number, bytesPerBundleByte: number = HEAP_BYTES_PER_BUNDLE_BYTE): number | null {
  const wanted = Math.ceil((bundleBytes * bytesPerBundleByte) / 2 ** 20);
  const cap = Math.floor((totalMemBytes * MEMORY_SHARE) / 2 ** 20);
  const target = Math.min(wanted, cap);
  return target > currentLimitMb + 512 ? target : null;
}

/** Re-runs this CLI invocation in a child Node with a bigger heap when
 *  `inputPath` needs one; resolves to the child's exit code. Returns null
 *  (run in-process) otherwise. */
export function maybeReexecForHeap(inputPath: string | undefined, bytesPerBundleByte: number = HEAP_BYTES_PER_BUNDLE_BYTE): Promise<number> | null {
  if (inputPath === undefined || process.env[MARKER] !== undefined) return null;
  const userSet = [...process.execArgv, process.env.NODE_OPTIONS ?? ""].some((a) => /--max-old-space-size/.test(a));
  if (userSet) return null;
  let bytes: number;
  try {
    bytes = statSync(inputPath).size;
  } catch {
    return null; // the command itself reports the missing input
  }
  const limit = heapLimitFor(bytes, getHeapStatistics().heap_size_limit / 2 ** 20, totalmem(), bytesPerBundleByte);
  if (limit === null) return null;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...process.execArgv, `--max-old-space-size=${limit}`, ...process.argv.slice(1)], {
      stdio: "inherit",
      env: { ...process.env, [MARKER]: String(limit) },
    });
    const forward = (sig: NodeJS.Signals): void => {
      child.kill(sig);
    };
    process.on("SIGINT", forward);
    process.on("SIGTERM", forward);
    child.on("exit", (code, signal) => resolve(code ?? (signal !== null ? 128 + (constants.signals[signal] ?? 0) : 1)));
    child.on("error", () => resolve(1));
  });
}
