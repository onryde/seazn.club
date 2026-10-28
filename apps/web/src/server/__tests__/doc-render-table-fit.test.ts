// W2d follow-up (review m2): a PDF table column is never narrower than its header. The widths are shared out by
// character count, so one long team name (46 characters here) squeezed every count column on a portrait page until a
// 3-letter header no longer fit and printed "…" — Pts, and IIHF's OTW / OTL, the columns the table exists for. Each
// column now gets at least its measured header (and, for a count, its widest cell), and the shortfall comes out of the
// widest text column — the team name, which already ellipsises.
//
// Real pdfkit and the real brand fonts, no mocks: every run below is read back out of the rendered PDF
// (e2e/pdf-uris.ts), and glyph widths come from pdfkit's own font metrics.
import { beforeAll, describe, expect, it } from "vitest";
import PDFDocument from "pdfkit";
import { buildStandings, type DocModel } from "@seazn/engine/exports";
import { FONT, registerFonts } from "../doc-theme";
import { MARGIN, docModelToPdf } from "../doc-render";
import { pdfTextRuns, type PdfTextRun } from "../../../e2e/pdf-uris";
import { useBrandFonts } from "./_sheet-fixtures";

beforeAll(useBrandFonts);

const A4 = { portrait: 595.28, landscape: 841.89 };
const LONG = "Northern Pines Hockey Club and Skating Society"; // 46 characters
// The header row is 8.5pt medium, the body 9pt regular (doc-render's drawRow).
const HEADER_SIZE = 8.5;

let meter: PDFKit.PDFDocument;
function width(run: PdfTextRun): number {
  meter ??= (() => { const m = new PDFDocument({ size: "A4" }); registerFonts(m); return m; })();
  return meter.font(run.size === HEADER_SIZE ? FONT.bodyMed : FONT.body).fontSize(run.size).widthOfString(run.text);
}

/** An IIHF table as the export builds it: the public table's P · W · OTW · OTL · D · L, hockey's ledger, Pts. */
function iihf(names: readonly string[], landscape: boolean): DocModel {
  return buildStandings(
    "Winter Ice League — Open",
    names.map((name, i) => ({
      name, played: 5, won: 1, drawn: 0, lost: 0, points: 9 - i,
      // A cell can be wider than its header (gd "-12", pim "120" under "gd" / "pim"): the floor covers both.
      results: [5, 1, 2, 2, 0, 0], metrics: { gf: 13, ga: 25, gd: -12, pim: 120 },
    })),
    { printedAt: "2026-10-28", metricColumns: ["gf", "ga", "gd", "pim"], resultColumns: ["P", "W", "OTW", "OTL", "D", "L"], landscape },
  );
}

/** The table's rows as drawn: runs grouped by baseline, header first, each left to right. */
async function drawnRows(model: DocModel): Promise<PdfTextRun[][]> {
  const runs = pdfTextRuns(await docModelToPdf(model));
  const table = model.sections[0]!.table!;
  const header = runs.find((r) => r.text === table.columns[2] && r.size === HEADER_SIZE);
  if (header === undefined) throw new Error("premise: the header row was drawn");
  const byY = new Map<number, PdfTextRun[]>();
  for (const r of runs) if (r.y >= header.y - 0.5 && r.page === header.page) (byY.get(Math.round(r.y)) ?? byY.set(Math.round(r.y), []).get(Math.round(r.y))!).push(r);
  return [...byY.entries()].sort(([a], [b]) => a - b).slice(0, table.rows.length + 1).map(([, row]) => row.sort((a, b) => a.x - b.x));
}

/** Every count header and cell printed whole, inside its own column and the page: returns how many were checked. */
function expectCountsWhole(rows: PdfTextRun[][], model: DocModel, pageWidth: number): number {
  const table = model.sections[0]!.table!;
  let checked = 0;
  rows.forEach((row, r) => {
    const want = (r === 0 ? table.columns : table.rows[r - 1]!).map(String);
    expect(row.length, `row ${r}: one run per cell`).toBe(want.length);
    row.forEach((run, i) => {
      if (i === 1) return; // the team name: the one column that may ellipsise
      expect(run.text, `row ${r} column ${table.columns[i]}`).toBe(want[i]);
      const right = run.x + width(run);
      const next = row[i + 1];
      if (next !== undefined) expect(right, `row ${r} ${want[i]} ends before ${next.text} starts`).toBeLessThanOrEqual(next.x + 0.01);
      expect(right, `row ${r} ${want[i]} inside the page`).toBeLessThanOrEqual(pageWidth - MARGIN + 0.01);
      checked++;
    });
  });
  return checked;
}

describe("doc-render tables: no column is narrower than its header", () => {
  it("portrait, a 46-character team name: Pts, OTW, OTL and every other count header and cell print whole, inside the page", async () => {
    const model = iihf([LONG, "Lakeside Lynx"], false);
    const rows = await drawnRows(model);
    const checked = expectCountsWhole(rows, model, A4.portrait);
    // 12 count columns (# and P W OTW OTL D L gf ga gd pim Pts) × (the header + 2 rows)
    expect(checked, "anti-vacuity: cells checked").toBe(12 * 3);
    // The room came out of the name's share, and it still had enough: 46 characters print whole.
    expect(rows[1]![1]!.text, "the long name still prints whole").toBe(LONG);
  });

  it("landscape, and a portrait page of short names: every header already fit, and still does", async () => {
    let checked = 0;
    for (const [model, page] of [[iihf([LONG, "Lakeside Lynx"], true), A4.landscape], [iihf(["Lynx", "Otters"], false), A4.portrait]] as const) {
      checked += expectCountsWhole(await drawnRows(model), model, page);
    }
    expect(checked, "anti-vacuity: cells checked").toBe(2 * 12 * 3);
  });

  it("a table that would fit only if the team column gave up its own header keeps the shared-out widths: Team prints whole", async () => {
    // Enough count columns that their floors leave the team column less than its own header ("Team" + padding), yet
    // no more than the page: the room is not taken below the giver's floor, so the plain shares stand.
    const head = (s: string) => width({ text: s, size: HEADER_SIZE } as PdfTextRun) + 8;
    const page = A4.portrait - 2 * MARGIN;
    const fixed = ["#", "P", "W", "D", "L", "Pts"].reduce((a, h) => a + head(h), 0);
    let n = 0;
    let floors = fixed;
    while (floors + head(`m${n}`) <= page) floors += head(`m${n++}`);
    // premise: the count floors fit the page, but not beside the team column's own header
    expect(floors, "premise: the floors fit the page").toBeLessThanOrEqual(page);
    expect(floors + head("Team"), "premise: but not beside Team's header").toBeGreaterThan(page);
    const metrics = Array.from({ length: n }, (_, i) => `m${i}`);
    const model = buildStandings(
      "Near",
      [{ name: LONG, played: 1, won: 1, drawn: 0, lost: 0, points: 3, metrics: Object.fromEntries(metrics.map((m) => [m, 1])) }],
      { printedAt: "2026-10-28", metricColumns: metrics },
    );
    const runs = pdfTextRuns(await docModelToPdf(model)).filter((r) => r.size === HEADER_SIZE);
    expect(runs.map((r) => r.text), "the Team header prints whole").toContain("Team");
  });

  it("a table whose headers cannot all fit keeps the shared-out widths and stays on the page (no column pushed off the edge)", async () => {
    // 60 count columns on a portrait page: their headers alone are wider than the page, so no floor can hold.
    const metrics = Array.from({ length: 60 }, (_, i) => `m${i}`);
    const model = buildStandings(
      "Wide",
      [{ name: LONG, played: 1, won: 1, drawn: 0, lost: 0, points: 3, metrics: Object.fromEntries(metrics.map((m) => [m, 1])) }],
      { printedAt: "2026-10-28", metricColumns: metrics },
    );
    const runs = pdfTextRuns(await docModelToPdf(model)).filter((r) => r.size === HEADER_SIZE);
    // The header row is the 8.5pt baseline most runs share (one run per column that had room to draw anything).
    const ys = new Map<number, number>();
    for (const r of runs) ys.set(r.y, (ys.get(r.y) ?? 0) + 1);
    const y = [...ys.entries()].sort(([, a], [, b]) => b - a)[0]![0];
    const header = runs.filter((r) => r.y === y).sort((a, b) => a.x - b.x);
    expect(header.length, "premise: the header row drew most of its 65 columns").toBeGreaterThan(50);
    for (const run of header) expect(run.x, `${run.text} starts on the page`).toBeLessThan(A4.portrait - MARGIN);
  });
});
