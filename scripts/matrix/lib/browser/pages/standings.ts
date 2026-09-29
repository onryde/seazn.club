// The organiser's standings tab, read as the page shows it (Task 5). Product
// facts, read at Step 0:
//  - d/[divSlug]/page.tsx:83 TABLE_KINDS = league, group, swiss; :812-818 with
//    no table stage the tab shows ONLY the note div.detail.standings.empty;
//    otherwise one StandingsTable per stage/pool (:850), captioned.
//  - public-site/standings-table.tsx: each table sits in
//    `<div role="region">` (:200) as its direct child (:205), always — the
//    region is returned even with no cut line (:387). A body row is
//    td(rank) then `<th scope="row">` (:326) whose name span carries
//    `title={entrantNames[row.entrantId] ?? row.entrantId}` (:340) — the FULL
//    name (below md the text is line-clamped). The rank cell is the chip, or a
//    tie/qualification popover whose button (chip first) precedes its hidden
//    panel (standings-popover.tsx) — so the cell's text STARTS with the rank.
//    The qualification cut line is a <tr> with no th (QualCutRow).
//  - The results grid (ResultsMatrix, inside <details>) is not in a region.
import type { PageCtx, DivisionWhere } from "./ctx.ts";
import { awaitScreen, navBudget, shoot, visit } from "./ctx.ts";
import { DATA, NAME } from "../selectors.ts";
import { paths } from "./paths.ts";

export interface UiTable { rows: { rank: number; name: string }[] }

export class UnreadableStandingsRow extends Error {
  readonly row: number;
  constructor(row: number, cells: readonly string[]) {
    super(`standings: row ${row} reads ${JSON.stringify(cells)} — no leading rank, or no name; the page is not read as a table it is not`);
    this.name = "UnreadableStandingsRow";
    this.row = row;
  }
}

/** One table's rows from its [rank cell text, name] pairs, IN THE ORDER THE
 *  PAGE SHOWS THEM — never re-sorted: the comparison with the API table
 *  (Task 6) must see a page that orders its rows wrongly. The rank is the
 *  cell's leading number; a row without one, or without a name, is refused. */
export function tablesFromCells(cells: readonly (readonly string[])[]): UiTable {
  return {
    rows: cells.map((row, i) => {
      const rank = /^\s*(\d+)/.exec(row[0] ?? "")?.[1];
      const name = (row[1] ?? "").trim();
      if (row.length < 2 || rank === undefined || name === "") throw new UnreadableStandingsRow(i + 1, row);
      return { rank: Number(rank), name };
    }),
  };
}

/** The element surface standingsCellsOf reads — a DOM Element meets it. */
export interface CellElement {
  readonly tagName: string;
  readonly children: ArrayLike<CellElement>;
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
  matches(selector: string): boolean;
  querySelector(selector: string): CellElement | null;
}

/** Per table, per body row that has a row header: [rank cell text, the row
 *  header's full name]. Runs IN THE PAGE (evaluateAll serialises it), so it
 *  reads nothing outside its arguments. */
export function standingsCellsOf(tables: readonly CellElement[], sel: { rowHeader: string; name: string }): string[][][] {
  return tables.map((table) => {
    const out: string[][] = [];
    for (const section of Array.from(table.children)) {
      if (section.tagName !== "TBODY") continue;
      for (const tr of Array.from(section.children)) {
        const cells = Array.from(tr.children);
        const head = cells.find((cell) => cell.tagName === "TH" && cell.matches(sel.rowHeader));
        if (head === undefined) continue;
        const rank = cells.find((cell) => cell.tagName === "TD");
        out.push([rank?.textContent ?? "", head.querySelector(sel.name)?.getAttribute("title") ?? ""]);
      }
    }
    return out;
  });
}

/** Every standings table inside `scope` (a region's direct <table>). */
export const TABLE_SELECTOR = `${DATA.standingsRegion.selector} > table`;
export const CELL_SELECTORS = Object.freeze({ rowHeader: DATA.standingsRowHeader.selector, name: DATA.standingsRowName.selector });

/** The organiser standings tab's tables, as shown; [] when the division has no
 *  table stage (the tab's own note says so, and is waited for — an empty
 *  answer is never read off a screen that did not render). */
export async function readStandingsUi(c: PageCtx, where: DivisionWhere): Promise<UiTable[]> {
  const { page } = c;
  await visit(c, paths.division(c.orgSlug, where.compSlug, where.divSlug, "standings"));
  const tables = page.locator(TABLE_SELECTOR);
  const none = page.getByText(NAME.standingsEmpty.text, { exact: true });
  const t = navBudget(c);
  await awaitScreen(() => tables.or(none).first().waitFor({ state: "attached", timeout: t }), "the standings tab's tables, or its no-table note", t);
  const cells = await tables.evaluateAll(standingsCellsOf, CELL_SELECTORS);
  await shoot(c, "10-standings");
  return cells.map(tablesFromCells);
}
