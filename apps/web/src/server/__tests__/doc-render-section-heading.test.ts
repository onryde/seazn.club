// Export every pool (2026-10-28): a group stage's standings now print one headed section per group ("Groups — Group B"),
// so a heading can land at the foot of a page. drawSection drew the heading wherever the cursor stood, and drawTable's
// own row check then sent the header row overleaf — "Group B" printed alone under Group A's last row, its table on the
// next page, where a reader takes it for the end of Group A. Review m2: and a pool that did start on the page could split
// 1 + 3, its last rows overleaf under no heading. A table that fits one page is now kept WHOLE (heading, header row, every
// row); one taller than a page keeps its heading with the header row and first body row, and breaks as before.
// Re-review I-1: the whole-table keep moved a 37-40 row FIRST section to page 2, leaving page 1 the title alone — moving
// a section already first on its page gains nothing. Such a section keeps only its heading, header row and first row.
//
// Real pdfkit and the real brand fonts, no mocks (doc-render.test.ts mocks pdfkit, and its fake cursor never moves, so a
// page break cannot be witnessed there): every run below is read back out of the rendered PDF (e2e/pdf-uris.ts).
import { beforeAll, describe, expect, it } from "vitest";
import { buildRoster, buildStandings, type DocModel, type ExportStandingsRow } from "@seazn/engine/exports";
import { docModelToPdf } from "../doc-render";
import { pdfTextRuns, type PdfTextRun } from "../../../e2e/pdf-uris";
import { useBrandFonts } from "./_sheet-fixtures";

beforeAll(useBrandFonts);

// drawSection's heading is 13pt; drawRow's header row 8.5pt, its body 9pt; the footer 7pt.
const HEADING_SIZE = 13;
const HEADER_SIZE = 8.5;
const BODY_SIZE = 9;
const HEADING = "Groups — Group B";
const HEADING_A = "Groups — Group A";

const row = (name: string, i: number): ExportStandingsRow => ({ name, played: 3, won: 1, drawn: 0, lost: 2, points: 3 - i, metrics: {} });

/** The export's own shape: a chrome model, then one headed section per group, each built by buildStandings. */
function twoGroups(aRows: number, bRows: number): DocModel {
  const group = (heading: string, names: readonly string[]) => ({ heading, ...buildStandings("t", names.map(row), { printedAt: "2026-10-28" }).sections[0]! });
  const chrome = buildStandings("Summer Open — Singles", [], { printedAt: "2026-10-28" });
  return {
    ...chrome,
    sections: [
      group(HEADING_A, Array.from({ length: aRows }, (_, i) => `Alpha ${i + 1}`)),
      group(HEADING, Array.from({ length: bRows }, (_, i) => `Bravo ${i + 1}`)),
    ],
  };
}

/** A section's heading, its header row's first run, and its body runs up to the next 13pt heading (the footer is 7pt). */
function sectionRuns(runs: readonly PdfTextRun[], heading: string): { heading: PdfTextRun; header: PdfTextRun; body: PdfTextRun[] } {
  const at = runs.findIndex((r) => r.text === heading && r.size === HEADING_SIZE);
  if (at < 0) throw new Error(`premise: ${heading}'s heading was drawn`);
  const headerAt = runs.findIndex((r, i) => i > at && r.size === HEADER_SIZE);
  const next = runs.findIndex((r, i) => i > at && r.size === HEADING_SIZE);
  const end = next < 0 ? runs.length : next;
  if (headerAt < 0 || headerAt > end) throw new Error(`premise: ${heading}'s header row was drawn`);
  return { heading: runs[at]!, header: runs[headerAt]!, body: runs.filter((r, i) => i > headerAt && i < end && r.size === BODY_SIZE) };
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
  it("Group A of every length from 1 to 60 rows: Group A, first on page 1, stays there with its header row and first row (re-review I-1); Group B — 4 rows, 2, or none — prints whole on one page, its heading, header row and every row", async () => {
    let checked = 0;
    let crossed = 0; // Group B started on a later page than the document: the sweep reached the page foot
    let aRunsOn = 0; // Group A ran on past page 1: the window where a whole-table keep would have moved it (I-1)
    for (const bRows of [4, 2, 0]) {
      for (let aRows = 1; aRows <= 60; aRows++) {
        const runs = pdfTextRuns(await docModelToPdf(twoGroups(aRows, bRows)));
        const { heading, header, body } = groupB(runs);
        const label = `A ${aRows} rows, B ${bRows}`;
        // Group A: the first section, nothing above it but the title — moving it overleaf would only leave page 1 bare.
        const a = sectionRuns(runs, HEADING_A);
        expect(a.heading.page, `${label}: Group A stays on the title's page`).toBe(runs[0]!.page);
        expect([a.header.page, a.body[0]!.page], `${label}: A's header row and first row with its heading`).toEqual([a.heading.page, a.heading.page]);
        expect(a.body.length, `${label}: premise: A's cells were drawn`).toBe(aRows * 7);
        if (a.body.at(-1)!.page > a.heading.page) aRunsOn++;
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
    // and some lengths of Group A must run on past page 1 (37-40 rows among them), or I-1's window was never reached
    expect(aRunsOn).toBeGreaterThan(0);
    expect(aRunsOn).toBeLessThan(checked);
  }, 180_000);

  it("not only standings — a roster: a first team of 28 to 44 players stays under the title on page 1, as does a team after its own page break; the next team that fits a page but not this one's remainder starts overleaf whole", async () => {
    const team = (name: string, n: number) => ({ teamName: name, players: Array.from({ length: n }, (_, i) => ({ name: `${name} player ${i + 1}`, number: i + 1 })) });
    let checked = 0;
    let runsOn = 0;
    for (let n = 28; n <= 44; n++) {
      const label = `${n} players`;
      // auto page breaks: the first team is first on page 1; the second (4 players) follows the first's signatures
      const runs = pdfTextRuns(await docModelToPdf(buildRoster("Summer Open — Rosters", [team("Harbour", n), team("Lakeside", 4)], { printedAt: "2026-10-28" })));
      const first = sectionRuns(runs, "Harbour");
      expect(first.heading.page, `${label}: the first team stays on the title's page`).toBe(runs[0]!.page);
      expect([first.header.page, first.body[0]!.page], `${label}: its header row and first row with its heading`).toEqual([first.heading.page, first.heading.page]);
      if (first.body.at(-1)!.page > first.heading.page) runsOn++;
      const second = sectionRuns(runs, "Lakeside");
      expect(second.body.filter((r) => r.page !== second.heading.page).map((r) => r.text), `${label}: the second team prints whole`).toEqual([]);
      // per team: the second team starts its own page (pageBreakBefore) — first on that page, so it stays there too
      const per = pdfTextRuns(await docModelToPdf(buildRoster("Summer Open — Rosters", [team("Harbour", 2), team("Lakeside", n)], { printedAt: "2026-10-28", pageBreaks: "per_team" })));
      const broken = sectionRuns(per, "Lakeside");
      expect(broken.heading.page, `${label}: after its page break, the team is on the next page, not one later`).toBe(per[0]!.page + 1);
      expect(broken.body[0]!.page, `${label}: its first row with its heading`).toBe(broken.heading.page);
      checked++;
    }
    expect(checked).toBe(17);
    expect(runsOn, "anti-vacuity: some first teams run on past page 1").toBeGreaterThan(0);
  }, 120_000);

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
