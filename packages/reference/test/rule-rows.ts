// The signed rule rows (packages/engine/rules/*.md, ruling 75). They are the reference families' only input besides the spec
// (R8), so a family's tests take their expected scope from here, never from the family. Read through the engine's PUBLISHED
// testkit (`allRows`, engine-split 1d review M1): the tables ship in the package, so this works from the installed package at 2b
// as it does from the workspace, and no test here names an engine path. Test-side only: src may not touch node:fs
// (scripts/reference-boundary.ts), and this file is outside src.
import { allRows } from "@seazn/engine/testkit";

export interface RuleRow {
  readonly id: string;
  readonly rule: string;
  readonly status: string;
  /** The rules file it sits in, without `.md`: a registered sport key, or `cross-sport`. */
  readonly file: string;
}

/** Every row of every rules file. Zero rows is a refusal, never an empty answer. `read` is the testkit's reader; a test hands it a stub. */
export function readRuleRows(read: () => readonly { id: string; rule: string; status: string; file: string }[] = allRows): RuleRow[] {
  const rows = read().map((r) => ({ id: r.id, rule: r.rule, status: r.status, file: r.file.slice(0, -".md".length) }));
  if (rows.length === 0) throw new Error("rule-rows: the engine's testkit read no rule row");
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

/** X-BR-1's level kinds, as the row's sentence reads them ("…; `draw`, `tie` and `no_result` are never a decided
 *  result"). Zero names is a refusal, not an empty answer. */
export function levelKindsFromXBR1(rows: readonly RuleRow[]): string[] {
  const { rule } = rowById(rows, "X-BR-1");
  const m = /; (.+?) are never a decided result/.exec(rule);
  if (m?.[1] === undefined) throw new Error(`rule-rows: X-BR-1 no longer reads "…; … are never a decided result": ${rule}`);
  const kinds = [...m[1].matchAll(/`([a-z_]+)`/g)].map((k) => k[1] ?? "");
  if (kinds.length === 0) throw new Error(`rule-rows: X-BR-1 names no level kind in "${m[1]}"`);
  return kinds;
}

/** X-BR-1's scope, "a bracket kind": every stage kind the engine declares where X-DR-1 allows no draw (ruling 78,
 *  "no level result where someone must advance"). */
export function bracketKindsFromRows(rows: readonly RuleRow[], stageKinds: readonly string[]): string[] {
  const draws = drawKindsFromXDR1(rows, stageKinds);
  return stageKinds.filter((k) => !draws.includes(k));
}
