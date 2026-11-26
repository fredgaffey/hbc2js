// `hbc2js deps` argument parsing -- docs/DECISIONS.md D17/D17a/D17b. Kept out
// of src/cli.ts (which runs on import) so the network default is unit-testable.

export interface DepsArgs {
  readonly help: boolean;
  readonly input: string | undefined;
  readonly out: string | undefined;
  readonly confirm: boolean;
  readonly confirmCache: boolean;
  readonly confirmJobs: number | undefined;
  readonly offline: boolean;
  readonly sigdb: string | undefined;
  readonly noSharedDb: boolean;
  readonly minInstr: number | undefined;
  readonly json: boolean;
  readonly exhaustive: boolean;
  readonly known: string | undefined;
}

export function parseDepsArgs(argv: readonly string[]): DepsArgs {
  let help = false;
  let input: string | undefined;
  let out: string | undefined;
  let confirm = false;
  let confirmCache = false;
  let confirmJobs: number | undefined;
  let offline = false;
  let online = false;
  let sigdb: string | undefined;
  let noSharedDb = false;
  let minInstr: number | undefined;
  let json = false;
  let exhaustive = false;
  let known: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") help = true;
    else if (a === "--out") out = argv[++i];
    else if (a === "--confirm") confirm = true;
    else if (a === "--confirm-cache") confirmCache = true;
    else if (a === "--confirm-jobs") confirmJobs = Math.max(1, Math.floor(Number(argv[++i])) || 1);
    else if (a === "--offline") offline = true;
    else if (a === "--online") online = true;
    else if (a === "--sigdb") sigdb = argv[++i];
    else if (a === "--no-shared-db") noSharedDb = true;
    else if (a === "--min-instr") minInstr = Number(argv[++i]);
    else if (a === "--json") json = true;
    else if (a === "--exhaustive") exhaustive = true;
    else if (a === "--known") known = argv[++i];
    else if (input === undefined && !a.startsWith("-")) input = a;
  }
  // Network is opt-in: no npm registry search unless `--online` or `--confirm`
  // (the confirm stage is network by definition); `--offline` wins over both.
  offline = offline || !(online || confirm);
  return { help, input, out, confirm, confirmCache, confirmJobs, offline, sigdb, noSharedDb, minInstr, json, exhaustive, known };
}
