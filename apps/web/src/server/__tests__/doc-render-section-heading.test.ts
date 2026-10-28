// Export every pool (2026-10-28): a group stage's standings now print one headed section per group ("Groups — Group B"),
// so a heading can land at the foot of a page. drawSection drew the heading wherever the cursor stood, and drawTable's
// own row check then sent the header row overleaf — "Group B" printed alone under Group A's last row, its table on the
// next page, where a reader takes it for the end of Group A. Review m2: and a pool that did start on the page could split
// 1 + 3, its last rows overleaf under no heading. A table that fits one page is now kept WHOLE (heading, header row, every
// row); one taller than a page keeps its heading with the header row and first body row, and breaks as before.
//
// Real pdfkit and the real brand fonts, no mocks (doc-render.test.ts mocks pdfkit, and its fake cursor never moves, so a
// page break cannot be witnessed there): every run below is read back out of the rendered PDF (e2e/pdf-uris.ts).
import { beforeAll, describe, expect, it } from "vitest";
import { buildStandings, type DocModel, type ExportStandingsRow } from "@seazn/engine/exports";
import { docModelToPdf } from "../doc-render";
import { pdfTextRuns, type PdfTextRun } from "../../../e2e/pdf-uris";
import { useBrandFonts } from "./_sheet-fixtures";

beforeAll(useBrandFonts);

// drawSection's heading is 13pt; drawRow's header row 8.5pt, its body 9pt; the footer 7pt.
const HEADING_SIZE = 13;
const HEADER_SIZE = 8.5;
const BODY_SIZE = 9;
const HEADING = "Groups — Group B";

const row = (name: string, i: number): ExportStandingsRow => ({ name, played: 3, won: 1, drawn: 0, lost: 2, points: 3 - i, metrics: {} });

/** The export's own shape: a chrome model, then one headed section per group, each built by buildStandings. */
function twoGroups(aRows: number, bRows: number): DocModel {
  const group = (heading: string, names: readonly string[]) => ({ heading, ...buildStandings("t", names.map(row), { printedAt: "2026-10-28" }).sections[0]! });
  const chrome = buildStandings("Summer Open — Singles", [], { printedAt: "2026-10-28" });
  return {
    ...chrome,
    sections: [
      group("Groups — Group A", Array.from({ length: aRows }, (_, i) => `Alpha ${i + 1}`)),
      group(HEADING, Array.from({ length: bRows }, (_, i) => `Bravo ${i + 1}`)),
    ],
  };
}

/** Group B's heading, then every header and body run drawn after it (B is the last section; the footer is 7pt). */
function groupB(runs: readonly PdfTextRun[]): { heading: PdfTextRun; header: PdfTextRun; body: PdfTextRun[] } {
  const at = runs.findIndex((r) => r.text === HEADING && r.size === HEADING_SIZE);
  if (at < 0) throw new Error("premise: Group B's heading was drawn");
  const headerAt = runs.findIndex((r, i) => i > at && r.size === HEADER_SIZE);
  if (headerAt < 0) throw new Error("premise: Group B's header row was drawn");
  return { heading: runs[at]!, header: runs[headerAt]!, body: runs.filter((r, i) => i > headerAt && r.size === BODY_SIZE) };
}

describe("doc-render: a section heading is kept with its table", () => {
  it("Group A of every length from 1 to 60 rows: Group B — 4 rows, 2, or none — prints whole on one page, its heading, header row and every row", async () => {
    let checked = 0;
    let crossed = 0; // Group B started on a later page than the document: the sweep reached the page foot
    for (const bRows of [4, 2, 0]) {
      for (let aRows = 1; aRows <= 60; aRows++) {
        const runs = pdfTextRuns(await docModelToPdf(twoGroups(aRows, bRows)));
        const { heading, header, body } = groupB(runs);
        const label = `A ${aRows} rows, B ${bRows}`;
        expect(header.page, `${label}: the header row sits on its heading's page`).toBe(heading.page);
        expect(header.y, `${label}: the header row sits below its heading`).toBeGreaterThan(heading.y);
        // every cell of every row: 4 rows of # · Team · P · W · D · L · Pts
        expect(body.length, `${label}: premise: B's cells were drawn`).toBe(bRows * 7);
        expect(body.filter((r) => r.page !== heading.page).map((r) => r.text), `${label}: no row of B overleaf`).toEqual([]);
        if (bRows > 0) expect(body[0]!.text, `${label}: B's first row`).toBe("1");
        if (heading.page > runs[0]!.page) crossed++;
        checked++;
      }
    }
    expect(checked).toBe(180);
    // anti-vacuity: some lengths of Group A must push Group B overleaf, or no page foot was ever met
    expect(crossed).toBeGreaterThan(0);
    expect(crossed).toBeLessThan(checked);
  }, 180_000);

  it("a heading with room under it stays where it is: no page is added for a table that fits", async () => {
    const runs = pdfTextRuns(await docModelToPdf(twoGroups(2, 2)));
    const { heading, header } = groupB(runs);
    expect(heading.page).toBe(runs[0]!.page);
    expect(header.page).toBe(runs[0]!.page);
  });

  it("a table taller than a page breaks as before: its heading stays where it has room, kept with the header row and first row, and its rows run on overleaf", async () => {
    const TALL = 60; // 61 rows of 18pt: more than an A4 page body
    let checked = 0;
    for (const aRows of [1, 20, 34, 40]) {
      const runs = pdfTextRuns(await docModelToPdf(twoGroups(aRows, TALL)));
      const { heading, header, body } = groupB(runs);
      const label = `A ${aRows} rows`;
      expect(header.page, `${label}: header with heading`).toBe(heading.page);
      expect(body[0]!.page, `${label}: first row with heading`).toBe(heading.page);
      expect(body.at(-1)!.page, `${label}: B runs on overleaf`).toBeGreaterThan(heading.page);
      if (aRows === 1) expect(heading.page, "a short Group A: B starts on the first page, not a fresh one").toBe(runs[0]!.page);
      checked++;
    }
    expect(checked).toBe(4);
  });
});
