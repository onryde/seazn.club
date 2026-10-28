// Export every pool (2026-10-28): a group stage's standings now print one headed section per group ("Groups — Group B"),
// so a heading can land at the foot of a page. drawSection drew the heading wherever the cursor stood, and drawTable's
// own row check then sent the header row overleaf — "Group B" printed alone under Group A's last row, its table on the
// next page, where a reader takes it for the end of Group A. A heading is now kept with its header row and first body
// row (an empty group: its header row).
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

/** Group B's heading, the header row drawn after it, and (when B has rows) its first body row — in drawing order. */
function groupB(runs: readonly PdfTextRun[]): { heading: PdfTextRun; header: PdfTextRun; body?: PdfTextRun } {
  const at = runs.findIndex((r) => r.text === HEADING && r.size === HEADING_SIZE);
  if (at < 0) throw new Error("premise: Group B's heading was drawn");
  const headerAt = runs.findIndex((r, i) => i > at && r.size === HEADER_SIZE);
  if (headerAt < 0) throw new Error("premise: Group B's header row was drawn");
  const body = runs.find((r, i) => i > headerAt && r.size === BODY_SIZE);
  return { heading: runs[at]!, header: runs[headerAt]!, ...(body !== undefined ? { body } : {}) };
}

describe("doc-render: a section heading is kept with its table", () => {
  it("Group A of every length from 1 to 60 rows: Group B's heading, header row and first row share a page (and an empty Group B keeps its header row)", async () => {
    let checked = 0;
    let crossed = 0; // Group B started on a later page than the document: the sweep reached the page foot
    for (const bRows of [2, 0]) {
      for (let aRows = 1; aRows <= 60; aRows++) {
        const runs = pdfTextRuns(await docModelToPdf(twoGroups(aRows, bRows)));
        const { heading, header, body } = groupB(runs);
        expect(header.page, `A ${aRows} rows, B ${bRows}: the header row sits on its heading's page`).toBe(heading.page);
        expect(header.y, `A ${aRows} rows, B ${bRows}: the header row sits below its heading`).toBeGreaterThan(heading.y);
        if (bRows > 0) {
          if (body === undefined) throw new Error(`premise: A ${aRows} rows — Group B's first row was drawn`);
          expect(body.page, `A ${aRows} rows: B's first row sits on its heading's page`).toBe(heading.page);
          expect(body.text).toBe("1");
        }
        if (heading.page > runs[0]!.page) crossed++;
        checked++;
      }
    }
    expect(checked).toBe(120);
    // anti-vacuity: some lengths of Group A must push Group B overleaf, or no page foot was ever met
    expect(crossed).toBeGreaterThan(0);
    expect(crossed).toBeLessThan(checked);
  }, 120_000);

  it("a heading with room under it stays where it is: no page is added for a table that fits", async () => {
    const runs = pdfTextRuns(await docModelToPdf(twoGroups(2, 2)));
    const { heading, header } = groupB(runs);
    expect(heading.page).toBe(runs[0]!.page);
    expect(header.page).toBe(runs[0]!.page);
  });
});
