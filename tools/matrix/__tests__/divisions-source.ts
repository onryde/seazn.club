// The divisions use-case is a FOLDER (`apps/web/src/server/usecases/divisions/`, one module per concern), no longer one file.
// The product text these tests read is the concatenation of every module in it, in name order, so a door sliced by its text is
// found wherever its module now lives. Anti-vacuity: a folder read that finds fewer than `MIN_MODULES` modules has lost some
// of the product, and a scan of less than the product proves less than it claims, so it THROWS.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const DIVISIONS_DIR = "apps/web/src/server/usecases/divisions";
/** The folder holds 7 modules (index.ts + 6) when this was written, and the floor is that count: a read below it is a lost scan
 *  (a module deleted, moved or misnamed), not a refactor. Splitting further only raises the count; removing a module lowers the floor on purpose. */
export const MIN_MODULES = 7;

/** The module files of the divisions folder, `index.ts` included, sorted. THROWS below `MIN_MODULES`. A `*.test.ts` beside them
 *  is not a module: it would count toward the floor and put test text into the product source the door tests read. */
export function divisionsModules(repo: string): string[] {
  const dir = resolve(repo, DIVISIONS_DIR);
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).sort();
  if (files.length < MIN_MODULES) throw new Error(`divisions-source: ${dir} holds ${files.length} modules, fewer than the ${MIN_MODULES} the scan needs`);
  return files;
}

/** Every divisions module's text, joined by a newline, in name order. */
export function divisionsSource(repo: string): string {
  const dir = resolve(repo, DIVISIONS_DIR);
  return divisionsModules(repo).map((f) => readFileSync(resolve(dir, f), "utf8")).join("\n");
}
