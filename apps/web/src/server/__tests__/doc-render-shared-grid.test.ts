// Export review I1 (2026-10-28): a group stage's standings print one table per pool, and each table sized its columns
// from its own cells — so one pool's 44-character name squeezed P … Pts into the right third of the page while the next
// pool's columns spread across it, and the same column jumped from pool to pool. Back-to-back tables with the same
// columns now share ONE grid: the widths and alignment of one table of all their rows. #1057's floor (review m2: no column
// narrower than its header, nor a count than its widest cell) holds over every pool's cells. Review m3: a pool with no
// rows yet had no cells to read its alignment from, so its count headers printed left-aligned; a header the document's
// other tables set as a number is set as one there too.
//
// Real pdfkit and the real brand fonts, no mocks: every run below is read back out of the rendered PDF (e2e/pdf-uris.ts),
// and glyph widths come from pdfkit's own font metrics.
import { beforeAll, describe, expect, it } from "vitest";
import PDFDocument from "pdfkit";
import { buildStandings, type DocModel, type DocSection, type ExportStandingsRow } from "@seazn/engine/exports";
import { FONT, registerFonts } from "../doc-theme";
import { MARGIN, docModelToPdf } from "../doc-render";
import { pdfTextRuns, type PdfTextRun } from "../../../e2e/pdf-uris";
import { useBrandFonts } from "./_sheet-fixtures";

beforeAll(useBrandFonts);

const A4_PORTRAIT = 595.28;
const LONG = "Northern Pines Hockey Club and Skating Society"; // 46 characters
// drawRow: the header row is 8.5pt medium, the body 9pt regular; each cell inset 4pt.
const HEADER_SIZE = 8.5;
const BODY_SIZE = 9;
const CELL_INSET = 4;

let meter: PDFKit.PDFDocument;
function width(run: PdfTextRun): number {
  meter ??= (() => { const m = new PDFDocument({ size: "A4" }); registerFonts(m); return m; })();
  return meter.font(run.size === HEADER_SIZE ? FONT.bodyMed : FONT.body).fontSize(run.size).widthOfString(run.text);
}

const IIHF_RESULTS = ["P", "W", "OTW", "OTL", "L"];
const row = (name: string, i: number): ExportStandingsRow => ({
  name, played: 5, won: 1, drawn: 0, lost: 0, points: 9 - i,
  // a cell can be wider than its header (gd "-12", pim "120"): the floor covers both
  results: [5, 1, 2, 2, 0], metrics: { gf: 13, ga: 25, gd: -12, pim: 120 },
});
/** One pool's section, as the export builds it: buildStandings' table under the pool's heading. */
function pool(heading: string, names: readonly string[], opts: { metrics?: string[]; results?: string[] } = {}): DocSection {
  const results = opts.results ?? IIHF_RESULTS;
  const model = buildStandings("t", names.map((n, i) => ({ ...row(n, i), results: [5, 1, 2, 2, 0, 0].slice(0, results.length) })), {
    printedAt: "2026-10-28",
    metricColumns: opts.metrics ?? ["gf", "ga", "gd", "pim"],
    resultColumns: results,
  });
  return { heading, ...model.sections[0]! };
}
const doc = (...sections: DocSection[]): DocModel => ({ ...buildStandings("Winter Ice League — Open", [], { printedAt: "2026-10-28" }), sections });

/** Each table's header row as drawn, in drawing order: its runs left to right. */
async function headerRows(model: DocModel): Promise<PdfTextRun[][]> {
  const runs = pdfTextRuns(await docModelToPdf(model));
  const rows = new Map<string, PdfTextRun[]>();
  for (const r of runs) if (r.size === HEADER_SIZE) (rows.get(`${r.page}:${Math.round(r.y)}`) ?? rows.set(`${r.page}:${Math.round(r.y)}`, []).get(`${r.page}:${Math.round(r.y)}`)!).push(r);
  return [...rows.values()].map((rs) => rs.sort((a, b) => a.x - b.x));
}
/** Every body run of the document (the footer is 7pt). */
const bodyRuns = async (model: DocModel) => pdfTextRuns(await docModelToPdf(model)).filter((r) => r.size === BODY_SIZE);

describe("doc-render: back-to-back tables with the same columns share one grid (export review I1)", () => {
  it("two pools, a 46-character name in either one: every header starts at the same x in both, and every count header and cell prints whole inside the page", async () => {
    let checked = 0;
    for (const [a, b] of [[[LONG, "Lynx"], ["Otters", "Bears"]], [["Otters", "Bears"], [LONG, "Lynx"]]] as const) {
      const model = doc(pool("Groups — Group A", a), pool("Groups — Group B", b));
      const columns = model.sections[0]!.table!.columns;
      const headers = await headerRows(model);
      expect(headers, "premise: two header rows").toHaveLength(2);
      const [ha, hb] = headers as [PdfTextRun[], PdfTextRun[]];
      expect(ha.map((r) => r.text), "A's header, whole").toEqual(columns);
      expect(hb.map((r) => r.text), "B's header, whole").toEqual(columns);
      for (const [k, label] of columns.entries()) {
        expect(hb[k]!.x, `${label} stands at the same x in both pools`).toBeCloseTo(ha[k]!.x, 1);
        checked++;
      }
      // #1057's floor over BOTH pools' cells: no count header or cell cut, none past the page.
      for (const r of [...ha, ...hb, ...(await bodyRuns(model))]) {
        expect(r.text, "nothing ellipsised").not.toContain("…");
        expect(r.x + width(r), `${r.text} inside the page`).toBeLessThanOrEqual(A4_PORTRAIT - MARGIN + 0.01);
      }
      const counts = (await bodyRuns(model)).filter((r) => /^-?\d+$/.test(r.text)).map((r) => r.text).sort();
      const want = model.sections.flatMap((s) => s.table!.rows.flatMap((cells) => cells.filter((_, i) => i !== 1).map(String))).sort();
      expect(counts, "every count cell printed whole").toEqual(want);
    }
    expect(checked, "columns compared across the two pools, both orders").toBe(2 * 12);
  });

  it("the positive pair: back-to-back tables with DIFFERENT columns each keep the grid they have alone", async () => {
    const iihf = pool("Groups — Group A", [LONG, "Lynx"]);
    const plain = pool("Groups — Group B", ["Otters", "Bears"], { metrics: [], results: ["P", "W", "D", "L"] });
    const [ha, hb] = (await headerRows(doc(iihf, plain))) as [PdfTextRun[], PdfTextRun[]];
    const [aloneA] = (await headerRows(doc(iihf))) as [PdfTextRun[]];
    const [aloneB] = (await headerRows(doc(plain))) as [PdfTextRun[]];
    expect(ha.map((r) => r.x), "A as alone").toEqual(aloneA.map((r) => r.x));
    expect(hb.map((r) => r.x), "B as alone").toEqual(aloneB.map((r) => r.x));
    // and the two grids do differ, or this pair proves nothing
    expect(hb.find((r) => r.text === "W")!.x, "W stands elsewhere in the other table").not.toBeCloseTo(ha.find((r) => r.text === "W")!.x, 0);
  });

  it("review m3: a pool with no rows yet sets its count headers as the document's other tables do — right-aligned, Pts against the page edge", async () => {
    // The empty pool's columns are the public table's over no rows (no metric any row carries): not its siblings'.
    const played = pool("Groups — Group A", ["Otters", "Bears"]);
    const empty = pool("Groups — Group B", [], { metrics: [] });
    expect(empty.table!.rows, "premise: B has no rows").toEqual([]);
    const [, hb] = (await headerRows(doc(played, empty))) as [PdfTextRun[], PdfTextRun[]];
    // The reference: the same table with one row of counts and a name no wider than "Team" — the same widths, and its
    // alignment read off its own cells.
    const one = pool("Groups — Group B", ["Abc"], { metrics: [] });
    const [, ref] = (await headerRows(doc(played, one))) as [PdfTextRun[], PdfTextRun[]];
    expect(hb.map((r) => r.text)).toEqual(ref.map((r) => r.text));
    let checked = 0;
    for (const [k, r] of hb.entries()) {
      expect(r.x, `${r.text}: aligned as on a table with rows`).toBeCloseTo(ref[k]!.x, 1);
      checked++;
    }
    expect(checked).toBe(hb.length);
    const pts = hb.at(-1)!;
    expect(pts.text).toBe("Pts");
    expect(pts.x + width(pts), "Pts right-aligned against the page edge").toBeCloseTo(A4_PORTRAIT - MARGIN - CELL_INSET, 0);
  });
});
