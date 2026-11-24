import { fileURLToPath } from "node:url";

/** Absolute path of a sibling worker module, with the extension matching the
 *  CALLER's own (`.ts` when running from src under strip-types, `.js` from the
 *  built dist/). A hardcoded `.ts` URL breaks every worker in an npm install. */
export function siblingWorkerPath(name: string, callerUrl: string): string {
  const ext = new URL(callerUrl).pathname.endsWith(".ts") ? ".ts" : ".js";
  return fileURLToPath(new URL(`./${name}${ext}`, callerUrl));
}
