// The migration's text and table list, DERIVED from the file (never typed), shared by
// migration-shape.test.ts, rls-static.test.ts, telemetry.test.ts and stream-contract.test.ts. A
// missing file reads as "" and [] — never a module-scope throw — so a red run before the migration
// exists still COLLECTS and fails on its assertions (a module-scope throw collects zero tests and
// reads green).
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const DELTAS = resolve(import.meta.dirname, "../../../../../../db/migration/deltas");
const ALL_DELTAS = readdirSync(DELTAS).filter((f) => /^V\d+__.+\.sql$/.test(f));
const version = (f: string): number => Number(/^V(\d+)__/.exec(f)![1]);
const file = ALL_DELTAS.find((f) => /^V\d+__stream_sessions\.sql$/.test(f));

/** V410's own text: the eight stream tables' `create table` bodies live here and nowhere else. */
export const MIGRATION: string = file ? readFileSync(join(DELTAS, file), "utf8") : "";

// ---- The fold (capture QR v2 T3, A4) ---------------------------------------------------------
// V410 and EVERY later delta whose name says stream or capture, in VERSION order (numeric, so a
// V1000 would sort after V999 — a string sort would not). A later delta can re-declare a CHECK
// list (V430 drops V410's inline end_reason check and re-adds it under the same name), so a list
// read from V410 alone answers yesterday's question.
const FOLD_FROM = file ? version(file) : Number.POSITIVE_INFINITY;
/** The folded files' names, in version order — exported so a test can pin V410 and V430 BY NAME. */
export const STREAM_DELTA_FILES: readonly string[] = ALL_DELTAS
  .filter((f) => version(f) >= FOLD_FROM && (f === file || /stream|capture/.test(f)))
  .sort((a, b) => version(a) - version(b));
/** Anti-vacuity: how many delta files the fold read. Zero means the fold proved nothing. */
export const STREAM_DELTA_COUNT: number = STREAM_DELTA_FILES.length;
/** Each folded file's text, in version order. */
export const STREAM_DELTA_TEXTS: readonly string[] = STREAM_DELTA_FILES.map((f) => readFileSync(join(DELTAS, f), "utf8"));
/** Every folded file's text, concatenated in version order. */
export const STREAM_DELTAS: string = STREAM_DELTA_TEXTS.join("\n");

/** SQL, not prose: every `--` comment is stripped (no folded file has `--` inside a string literal). */
export const stripSqlComments = (sqlText: string): string => sqlText.replace(/--.*$/gm, "");

/** Every table the fold creates — V410's eight, then V430's four. */
export const STREAM_TABLES: string[] = [...stripSqlComments(STREAM_DELTAS).matchAll(/^create table (\w+)/gm)].map((m) => m[1]!);

const quoted = (list: string): string[] => [...list.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every `in (…)` CHECK list one file declares for `table.column`, in source order. Two forms:
 *   - INLINE, unnamed, on the column's own line: `end_reason text null check (end_reason in (…))`
 *     inside `create table <table> (`, or the same on an `alter table <table> add column`;
 *   - NAMED: `alter table <table> … add constraint <name> check (<column> in (…))`. */
function checkListsIn(sqlText: string, table: string, column: string): { at: number; values: string[] }[] {
  const text = stripSqlComments(sqlText);
  const col = esc(column);
  const found: { at: number; values: string[] }[] = [];
  const inline = new RegExp(`(?:^|\\n|,)\\s*(?:add column\\s+(?:if not exists\\s+)?)?${col}\\s+text\\b[^,;]*?check \\(${col} in \\(([^)]*)\\)\\)`, "g");
  for (const m of text.matchAll(/create table (\w+) \(([\s\S]*?)\n\);/g)) {
    if (m[1] !== table) continue;
    const bodyAt = m.index! + m[0].indexOf("(") + 1;
    for (const c of m[2]!.matchAll(inline)) found.push({ at: bodyAt + c.index!, values: quoted(c[1]!) });
  }
  const named = new RegExp(`add constraint \\w+\\s+check \\(${col} in \\(([^)]*)\\)\\)`, "g");
  for (const m of text.matchAll(/alter table (?:only\s+)?(\w+)\b([^;]*);/g)) {
    if (m[1] !== table) continue;
    const bodyAt = m.index! + m[0].length - m[2]!.length - 1;
    for (const c of m[2]!.matchAll(inline)) found.push({ at: bodyAt + c.index!, values: quoted(c[1]!) });
    for (const c of m[2]!.matchAll(named)) found.push({ at: bodyAt + c.index!, values: quoted(c[1]!) });
  }
  return found.sort((a, b) => a.at - b.at);
}

/** The CHECK list `table.column` holds after `sources` (default: the whole fold) — the LAST
 *  definition in version order wins, and within one file the last in source order. Empty when no
 *  folded file declares one: the empty case, never a default. */
export function lastCheckList(table: string, column: string, sources: readonly string[] = STREAM_DELTA_TEXTS): string[] {
  let last: string[] = [];
  for (const text of sources) {
    const lists = checkListsIn(text, table, column);
    if (lists.length > 0) last = lists[lists.length - 1]!.values;
  }
  return last;
}

/** One folded file's text by its version, for the ordering differential ("" when absent). */
export function deltaText(v: number): string {
  const i = STREAM_DELTA_FILES.findIndex((f) => version(f) === v);
  return i === -1 ? "" : STREAM_DELTA_TEXTS[i]!;
}
