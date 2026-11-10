// The stream-sessions use-case is a FOLDER (`server/usecases/stream-sessions/`, one module per concern), no longer one file.
// The source text the scans in this directory read is every module of it, in name order, so a function or a name is found
// wherever its module now lives. Anti-vacuity: a read that finds fewer than `MIN_MODULES` modules has lost some of the
// product, and a scan of less than the product proves less than it claims, so it THROWS.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dirname, "..", "stream-sessions");
/** The folder holds 23 files (index.ts + 22 modules) when this was written, and the floor is that count: a read below it is a
 *  lost scan (a module deleted, moved or misnamed), not a refactor. Removing a module is legal and lowers the floor in the same change. */
export const MIN_MODULES = 23;

/** The module files of the folder, `index.ts` included, sorted. THROWS below `MIN_MODULES`. */
export function streamSessionsModules(): string[] {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".ts")).sort();
  if (files.length < MIN_MODULES) throw new Error(`stream-sessions-source: ${DIR} holds ${files.length} modules, fewer than the ${MIN_MODULES} the scan needs`);
  return files;
}

/** Each module's text, in name order; `map` runs on every module BEFORE they are joined (so a per-file transform such as
 *  stripping a module's imports never reaches across a module boundary). */
export function streamSessionsSource(map: (text: string) => string = (t) => t): string {
  return streamSessionsModules().map((f) => map(readFileSync(join(DIR, f), "utf8"))).join("\n");
}
