// The signed rule rows (packages/engine/rules/*.md, ruling 75), read as TEXT. They are the reference families' only
// input besides the spec (R8), so a family's tests take their expected scope from here, never from the family.
// Test-side only: src may not touch node:fs (scripts/reference-boundary.ts), and this file is outside src.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const RULES_DIR = fileURLToPath(new URL("../../engine/rules/", import.meta.url));
const ROW_ID = /^[A-Z]+-[A-Z]+-\d+$/;

export interface RuleRow {
  readonly id: string;
  readonly rule: string;
  readonly status: string;
  /** The rules file it sits in, without `.md`: a registered sport key, or `cross-sport`. */
  readonly file: string;
}

/** Every row of every rules file. Zero files or zero rows is a refusal, never an empty answer. */
export function readRuleRows(dir: string = RULES_DIR): RuleRow[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md").sort();
  if (files.length === 0) throw new Error(`rule-rows: no rules file in ${dir}`);
  const rows: RuleRow[] = [];
  for (const f of files) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line.startsWith("|")) continue;
      const cells = line.split("|").map((c) => c.trim());
      const id = cells[1] ?? "";
      if (!ROW_ID.test(id)) continue; // the header and the separator line
      // | id | rule | citation | status | enforced at | proved by |  →  8 cells after the split (two empty ends).
      if (cells.length !== 8) throw new Error(`rule-rows: ${f}: row ${id} has ${cells.length - 2} cells, expected 6 (a "|" inside a cell?)`);
      rows.push({ id, rule: cells[2] ?? "", status: cells[4] ?? "", file: f.slice(0, -".md".length) });
    }
  }
  if (rows.length === 0) throw new Error(`rule-rows: ${files.length} rules file(s) in ${dir} and not one row parsed`);
  return rows;
}

export function rowById(rows: readonly RuleRow[], id: string): RuleRow {
  const hits = rows.filter((r) => r.id === id);
  if (hits.length !== 1) throw new Error(`rule-rows: expected exactly one row ${id}, found ${hits.length}`);
  const [row] = hits;
  if (row === undefined) throw new Error(`rule-rows: ${id} vanished`);
  return row;
}

/** X-DR-1's draw allow-list, as the row's sentence reads it ("Draws are allowed only in a, b, c and d, and only
 *  where …"). Every name must be a stage kind the engine declares — a name it does not is a refusal, not a skip. */
export function drawKindsFromXDR1(rows: readonly RuleRow[], stageKinds: readonly string[]): string[] {
  const { rule } = rowById(rows, "X-DR-1");
  const m = /allowed only in (.+?), and only where/.exec(rule);
  if (m?.[1] === undefined) throw new Error(`rule-rows: X-DR-1 no longer reads "allowed only in …, and only where": ${rule}`);
  const kinds = m[1].split(/, | and /).map((k) => k.trim());
  const unknown = kinds.filter((k) => !stageKinds.includes(k));
  if (kinds.length === 0 || unknown.length > 0) throw new Error(`rule-rows: X-DR-1 names ${JSON.stringify(unknown)}, not stage kinds the engine declares`);
  return kinds;
}

/** X-BR-1's scope, "a bracket kind": every stage kind the engine declares where X-DR-1 allows no draw (ruling 78,
 *  "no level result where someone must advance"). */
export function bracketKindsFromRows(rows: readonly RuleRow[], stageKinds: readonly string[]): string[] {
  const draws = drawKindsFromXDR1(rows, stageKinds);
  return stageKinds.filter((k) => !draws.includes(k));
}
