// The rules reference (W2a ruling 75, spec §6). One row per line of a
// markdown table whose header is exactly ROW_HEADER. Cells are split on " | ";
// `enforced at` and `proved by` hold backticked paths separated by "<br>".
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO = resolve(ENGINE, "..", "..");
export const RULES_DIR = join(ENGINE, "rules");
export const ROW_HEADER = "| id | rule | citation | status | enforced at | proved by |";
export const STATUS = /^(signed \d+ \d{4}-\d{2}-\d{2}|deviation \d+ \d{4}-\d{2}-\d{2}|⬜ open)$/;
export const ID = /^[A-Z]{1,3}-[A-Z]{2}-\d+$/;

export interface RuleRow {
  id: string; rule: string; citation: string; status: string;
  enforcedAt: string[]; provedBy: string[]; file: string;
}

const paths = (cell: string): string[] =>
  cell.trim() === "—" ? [] : cell.split("<br>").map((p) => p.trim().replace(/^`|`$/g, "")).filter((p) => p !== "");

export function parseRuleRows(text: string, file: string): RuleRow[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === ROW_HEADER);
  if (start === -1) return [];
  const rows: RuleRow[] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("| ")) break;
    const cells = line.slice(2, -2).split(" | ");
    if (cells.length !== 6) throw new Error(`${file}: a rule row has ${cells.length} cells, not 6: ${line}`);
    const [id, rule, citation, status, enforced, proved] = cells.map((c) => c.trim()) as [string, string, string, string, string, string];
    rows.push({ id, rule, citation, status, enforcedAt: paths(enforced), provedBy: paths(proved), file });
  }
  return rows;
}

export function ruleFiles(): string[] {
  return readdirSync(RULES_DIR).filter((f) => f.endsWith(".md") && f !== "README.md").sort();
}

export function allRows(): RuleRow[] {
  return ruleFiles().flatMap((f) => parseRuleRows(readFileSync(join(RULES_DIR, f), "utf8"), f));
}

/** A `proved by` entry is a repo-relative test path, or a matrix case id prefixed `matrix:`. */
export const isMatrixCase = (p: string): boolean => p.startsWith("matrix:");
export const fileExists = (p: string): boolean => existsSync(join(REPO, p));
export const fileNames = (p: string, id: string): boolean => readFileSync(join(REPO, p), "utf8").includes(id);

/** The proving checks for one signed row, as data: exported so a synthetic row exercises them while every real row
 *  still awaits proof (preflight C5: at Task 2 no real row reaches these branches). */
export function proofProblems(r: RuleRow): string[] {
  const tests = r.provedBy.filter((p) => !isMatrixCase(p));
  if (tests.length === 0) return [`${r.id} names no proving test`];
  const out: string[] = [];
  for (const p of tests) {
    if (!fileExists(p)) out.push(`${r.id}: ${p} does not exist`);
    else if (!fileNames(p, r.id)) out.push(`${r.id}: ${p} does not contain "${r.id}"`);
  }
  return out;
}
