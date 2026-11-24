// Phase/count progress lines on stderr for the long-running commands (`export`,
// `deps`: minutes on a real app, previously silent). stderr only -- stdout
// (the report / --json) is never touched. Off unless a command enables it, and
// the CLI leaves it off under --json so a machine consumer sees nothing extra.
let enabled = false;
let label = "hbc2js";
let startedAt = 0;
let lastAt = 0;

export function enableProgress(commandName: string): void {
  enabled = true;
  label = `hbc2js ${commandName}`;
  startedAt = lastAt = Date.now();
}

export function disableProgress(): void {
  enabled = false;
}

export function progress(message: string): void {
  if (!enabled) return;
  // Per-phase durations: time since the previous progress line (the phase
  // that just ended) and since the command started.
  const now = Date.now();
  const sec = (ms: number): string => (ms / 1000).toFixed(1);
  process.stderr.write(`${label}: ${message} [+${sec(now - lastAt)}s, ${sec(now - startedAt)}s]\n`);
  lastAt = now;
}

/** Whether progress lines are on (a worker thread that runs part of a
 *  command mirrors the main thread's setting; see src/export/deps-worker.ts). */
export function progressEnabled(): boolean {
  return enabled;
}
