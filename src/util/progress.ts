// Phase/count progress lines on stderr for the long-running commands (`export`,
// `deps`: minutes on a real app, previously silent). stderr only -- stdout
// (the report / --json) is never touched. Off unless a command enables it, and
// the CLI leaves it off under --json so a machine consumer sees nothing extra.
let enabled = false;
let label = "hbc2js";

export function enableProgress(commandName: string): void {
  enabled = true;
  label = `hbc2js ${commandName}`;
}

export function disableProgress(): void {
  enabled = false;
}

export function progress(message: string): void {
  if (enabled) process.stderr.write(`${label}: ${message}\n`);
}
