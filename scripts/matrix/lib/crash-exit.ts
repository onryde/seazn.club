// Preloaded (node --import) by every W1b CLI's package script — matrix:l3,
// matrix:render, matrix:catalogue, matrix:single-sport, matrix:model and
// reference:boundary (final batch F-6). Each CLI promises "3 = crash, never
// 1", because 1 reads as a verdict (drift, a ratchet violation, a NEW
// failure). Its main keeps that promise; but a failure to LOAD the CLI — a
// parse error under strip-types, a missing export, a module that throws while
// it evaluates — happens before any CLI code runs, and node exits 1. A preload
// runs first, so it is the one place that can see those: any exception nothing
// caught becomes exit 3. Only a preload: imported into a vitest worker, this
// handler would take over the worker's own crashes. A bare
// `node --experimental-strip-types <cli>` run has no preload, and a load
// failure there still exits 1 — run the package script.
import { basename } from "node:path";

process.on("uncaughtException", (e: unknown) => {
  const what = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  const stack = e instanceof Error && e.stack !== undefined ? `\n${e.stack}` : "";
  process.stderr.write(`${basename(process.argv[1] ?? "cli")}: crashed — nothing caught ${what} (exit 3: a crash, never a verdict)${stack}\n`);
  process.exit(3);
});
