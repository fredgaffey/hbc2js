// node --test reporter: writes per-file wall time (sum of top-level test durations)
// as JSON to $HBC2JS_DURATIONS_OUT (default test-durations.json in cwd).
import { writeFileSync } from "node:fs";
export default async function* durationsReporter(source) {
  const files = new Map();
  for await (const ev of source) {
    if ((ev.type === "test:pass" || ev.type === "test:fail") && ev.data.nesting === 0 && ev.data.file) {
      const f = ev.data.file;
      files.set(f, (files.get(f) ?? 0) + (ev.data.details?.duration_ms ?? 0));
    }
  }
  const rows = [...files].map(([file, ms]) => ({ file, ms: Math.round(ms) })).sort((a, b) => b.ms - a.ms);
  writeFileSync(process.env.HBC2JS_DURATIONS_OUT ?? "test-durations.json", JSON.stringify(rows, null, 1));
  yield "";
}
