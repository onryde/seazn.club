// W2b's rule rows, read as TEXT from the approved spec's Appendix A (spec 2026-10-08-format-matrix-w2b-design.md). They
// reach packages/engine/rules/ only at Task 14, so until then the spec is the rows' one written source; the W2b
// reference families (lane P2, R8) read their expected scope from here, never from a family. Test-side only: src may
// not touch node:fs (scripts/reference-boundary.ts), and this file is outside src.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readRuleRows, type RuleRow } from "./rule-rows.ts";

export const W2B_SPEC = fileURLToPath(new URL("../../../docs/superpowers/specs/2026-10-08-format-matrix-w2b-design.md", import.meta.url));
const ROW_ID = /^[A-Z]+-[A-Z]+-\d+$/;
const SECTION = /^### `([a-z-]+)\.md/;

export interface AppendixA {
  readonly rows: readonly RuleRow[];
  /** Row-shaped lines whose id is not a plain id — "X-BR-1 (amend)". Kept so the count can be pinned. */
  readonly amendments: readonly string[];
  /** The total the appendix states of itself ("54 rows: …"). */
  readonly statedTotal: number;
}

/** Every row of Appendix A, each with the rules file its subsection names. Zero rows is a refusal, never an empty
 *  answer; a row before any subsection, or a row with the wrong cell count, is a refusal too. */
export function readAppendixA(path: string = W2B_SPEC): AppendixA {
  const text = readFileSync(path, "utf8");
  const at = text.indexOf("\n## Appendix A");
  if (at < 0) throw new Error(`appendix-a: ${path} has no "## Appendix A" section`);
  const body = text.slice(at);
  const stated = /\n(\d+) rows: /.exec(body);
  if (stated?.[1] === undefined) throw new Error("appendix-a: the appendix no longer states its own total (\"N rows: …\")");
  let file: string | null = null;
  const rows: RuleRow[] = [];
  const amendments: string[] = [];
  for (const line of body.split("\n")) {
    const h = SECTION.exec(line);
    if (h?.[1] !== undefined) { file = h[1]; continue; }
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    const id = cells[1] ?? "";
    if (id === "id" || /^-+$/.test(id)) continue; // the header and the separator line
    if (!ROW_ID.test(id)) { amendments.push(id); continue; }
    if (file === null) throw new Error(`appendix-a: row ${id} sits before any "### \`<file>.md\`" subsection`);
    if (cells.length !== 8) throw new Error(`appendix-a: row ${id} has ${cells.length - 2} cells, expected 6`);
    rows.push({ id, rule: cells[2] ?? "", status: cells[4] ?? "", file });
  }
  if (rows.length === 0) throw new Error(`appendix-a: no row parsed from ${path}`);
  return { rows, amendments, statedTotal: Number(stated[1]) };
}

/** The rows a W2b family answers from: every rules-directory row, plus each Appendix A row the directory does not yet
 *  hold (the directory wins once Task 14 has written a row there, so no id is ever read twice). */
export function readRowsWithAppendixA(): RuleRow[] {
  const dir = readRuleRows();
  const have = new Set(dir.map((r) => r.id));
  return [...dir, ...readAppendixA().rows.filter((r) => !have.has(r.id))];
}
