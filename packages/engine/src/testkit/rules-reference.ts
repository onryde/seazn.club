// The rules reference parser (W2a ruling 75, spec §6; published through the testkit by engine-split 1d-5, R12).
//
// One row per line of a markdown table whose header is exactly RULE_ROW_HEADER. Cells are split on " | "; `enforced at` and
// `proved by` hold backticked paths separated by "<br>". The tables are `rules/*.md` at the package root, which ships in the
// tarball (package.json "files"), so the one URL below is right from `src/testkit/` AND from `dist/testkit/`.
//
// This module reads the disk (node:fs), and is one of the TWO disk-reading modules the testkit barrel exports (the other is corpora.ts,
// engine-split 2b R1): its input ships with the package, where the other disk readers (golden.ts, dossiers.ts, conformance-pad.ts) read
// files that do not. The engine test `the published testkit barrel's disk-reading closure is exactly the rules reference and the corpora
// reader` holds that exception to these two files alone.
//
// Pure of every repo path on purpose: what a row's paths mean (which test proves a rule, where it is enforced) is the checker's
// business, and the checker reads the repo, which a package consumer does not have. See test/rules-reference.ts.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const RULES_DIR = fileURLToPath(new URL("../../rules", import.meta.url));
export const RULE_ROW_HEADER = "| id | rule | citation | status | enforced at | proved by |";
export const RULE_STATUS = /^(signed \d+ \d{4}-\d{2}-\d{2}|deviation \d+ \d{4}-\d{2}-\d{2}|⬜ open)$/;
export const RULE_ID = /^[A-Z]{1,3}-[A-Z]{2}-\d+$/;
/** A line that looks like a rule row. The parser reads one table; a row-shaped line it did not read is a failure. */
export const RULE_ROW_SHAPED = /^\| [A-Z]{1,3}-[A-Z]{2}-\d+ \|/;

export interface RuleRow {
  id: string; rule: string; citation: string; status: string;
  enforcedAt: string[]; provedBy: string[]; file: string;
}

const paths = (cell: string): string[] =>
  cell.trim() === "—" ? [] : cell.split("<br>").map((p) => p.trim().replace(/^`|`$/g, "")).filter((p) => p !== "");

export function parseRuleRows(text: string, file: string): RuleRow[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === RULE_ROW_HEADER);
  const rows: RuleRow[] = [];
  const read = new Set<number>();
  if (start !== -1) {
    for (const [i, line] of lines.entries()) {
      if (i < start + 2) continue;
      if (!line.startsWith("| ")) break;
      const cells = line.slice(2, -2).split(" | ");
      if (cells.length !== 6) throw new Error(`${file}: a rule row has ${cells.length} cells, not 6: ${line}`);
      const [id, rule, citation, status, enforced, proved] = cells.map((c) => c.trim()) as [string, string, string, string, string, string];
      rows.push({ id, rule, citation, status, enforcedAt: paths(enforced), provedBy: paths(proved), file });
      read.add(i);
    }
  }
  // Spec §6: a row the parser skips is a failure, not a row nobody checks. The table ends at the first non-row line,
  // so a row after prose, a second table, or a file with no header at all would otherwise be silently unchecked.
  const skipped = lines.flatMap((l, i) => (RULE_ROW_SHAPED.test(l) && !read.has(i) ? [`line ${i + 1}: ${l.slice(0, 48)}`] : []));
  if (skipped.length > 0) throw new Error(`${file}: ${skipped.length} row-shaped line(s) not read as rows (a row after prose, a second table, or no table header): ${skipped.join("; ")}`);
  return rows;
}

export function ruleFiles(): string[] {
  return readdirSync(RULES_DIR).filter((f) => f.endsWith(".md") && f !== "README.md").sort();
}

export function allRows(): RuleRow[] {
  return ruleFiles().flatMap((f) => parseRuleRows(readFileSync(join(RULES_DIR, f), "utf8"), f));
}
