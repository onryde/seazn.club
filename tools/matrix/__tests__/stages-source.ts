// The stages use-case is a FOLDER (`apps/web/src/server/usecases/stages/`, one module per concern), no longer one file.
// The product text these tests read is the concatenation of every module in it, in name order, so a function sliced by
// name is found wherever its module now lives. Anti-vacuity: a folder read that finds fewer than `MIN_MODULES` modules has
// lost some of the product, and a scan of less than the product proves less than it claims, so it THROWS.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const STAGES_DIR = "apps/web/src/server/usecases/stages";
/** The folder holds 19 modules (index.ts + 18) when this was written; a read below this floor is a lost scan, not a refactor. */
export const MIN_MODULES = 10;

/** The module files of the stages folder, `index.ts` included, sorted. THROWS below `MIN_MODULES`. */
export function stagesModules(repo: string): string[] {
  const dir = resolve(repo, STAGES_DIR);
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts")).sort();
  if (files.length < MIN_MODULES) throw new Error(`stages-source: ${dir} holds ${files.length} modules, fewer than the ${MIN_MODULES} the scan needs`);
  return files;
}

/** Every stages module's text, joined by a newline, in name order. */
export function stagesSource(repo: string): string {
  const dir = resolve(repo, STAGES_DIR);
  return stagesModules(repo).map((f) => readFileSync(resolve(dir, f), "utf8")).join("\n");
}
