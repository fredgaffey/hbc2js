// ui/e2e/select.mjs — per-run isolation for the Playwright suite: free ports
// (probed by binding port 0, or from HBC2JS_E2E_PORT_BASE when set) and a
// unique mkdtemp fixture root (or HBC2JS_E2E_ROOT when set). The reservation
// sockets stay open until release(), so two concurrent selections in one
// process can never return the same port. A busy explicit port is an error:
// we never reuse a stranger's server.
import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function reserve(port) {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen({ port, host: "127.0.0.1", exclusive: true }, () => resolve(s));
  });
}
const close = (s) => new Promise((r) => s.close(() => r()));

export async function selectE2E(env = process.env) {
  const held = [];
  try {
    let apiPort, previewPort;
    const base = env["HBC2JS_E2E_PORT_BASE"];
    if (base !== undefined && base !== "") {
      apiPort = Number(base);
      previewPort = apiPort + 1;
      for (const p of [apiPort, previewPort]) {
        try { held.push(await reserve(p)); } catch { throw new Error(`HBC2JS_E2E_PORT_BASE: port ${p} is busy; refusing to reuse another process's server`); }
      }
    } else {
      const a = await reserve(0), b = await reserve(0);
      held.push(a, b);
      apiPort = a.address().port;
      previewPort = b.address().port;
    }
    const explicitRoot = env["HBC2JS_E2E_ROOT"];
    const owned = explicitRoot === undefined || explicitRoot === "";
    const root = owned ? mkdtempSync(join(tmpdir(), "hbc2js-ui-e2e-")) : explicitRoot;
    return { apiPort, previewPort, root, ownsRoot: owned, release: () => Promise.all(held.map(close)).then(() => undefined) };
  } catch (e) {
    await Promise.all(held.map(close));
    throw e;
  }
}
