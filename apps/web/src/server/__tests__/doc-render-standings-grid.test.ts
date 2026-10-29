// Standings export parity, item 5 (2026-10-29): a standings table's column widths. The widths used to be shared out by
// character count, so with short team names ("E1" … "E8") every count column took about the Team column's share and the
// numbers floated across the page; and two pools of one stage — one with a D column, one without — started their Team
// column at different x. Now a standings table's count / result / derived columns each take the width their own header and
// cells measure (a small breathing room, a cap on what a cell may claim), `#` a fixed width, and Team the rest — so a
// pool's # and Team begin at the same x whatever else its table prints.
//
// The rule is scoped to the standings kind: a timetable, roster or rota keeps the proportional grid it always had (pinned
// below against positions recorded on the renderer as it stood before this change).
//
// Real pdfkit and the real brand fonts, no mocks: every position below is read back out of the rendered PDF
// (e2e/pdf-uris.ts), and glyph widths come from pdfkit's own font metrics (a meter document), never from doc-render.
import { beforeAll, describe, expect, it } from "vitest";
import PDFDocument from "pdfkit";
import { buildParticipants, buildRoster, buildStandings, buildTimetable, type DocModel, type DocSection, type ExportStandingsRow } from "@seazn/engine/exports";
import { FONT, registerFonts } from "../doc-theme";
import { COUNT_CAP, MARGIN, docModelToPdf } from "../doc-render";
import { pdfTextRuns, type PdfTextRun } from "../../../e2e/pdf-uris";
import { useBrandFonts } from "./_sheet-fixtures";

beforeAll(useBrandFonts);

const A4_PORTRAIT = 595.28;
const CONTENT = A4_PORTRAIT - 2 * MARGIN;
const HEADER_SIZE = 8.5;
const BODY_SIZE = 9;
/** drawRow insets every cell 4pt on both sides. */
const CELL_INSET = 4;
/** How far above its own measured content (text + both insets) a count column may grow: a small breathing room. */
const ROOM = 16;

let meter: PDFKit.PDFDocument;
function measure(text: string, size: number): number {
  meter ??= (() => { const m = new PDFDocument({ size: "A4" }); registerFonts(m); return m; })();
  return meter.font(size === HEADER_SIZE ? FONT.bodyMed : FONT.body).fontSize(size).widthOfString(text);
}

const result = (i: number): ExportStandingsRow["results"] => [3 + (i % 3), 1 + (i % 2), 1, 1 + (i % 2)];
const row = (name: string, i: number, over: Partial<ExportStandingsRow> = {}): ExportStandingsRow => ({
  name, played: 6, won: 3, drawn: 1, lost: 2, points: 10 - i, metrics: { gf: 12 - i, ga: 4 + i, gd: 8 - 2 * i }, results: result(i), ...over,
});

/** One table's section, as the export builds it. */
function table(heading: string | undefined, names: readonly string[], opts: { results?: string[]; metrics?: string[]; rows?: (n: string, i: number) => ExportStandingsRow } = {}): DocSection {
  const results = opts.results ?? ["P", "W", "D", "L"];
  const model = buildStandings("t", names.map((n, i) => (opts.rows ?? row)(n, i)).map((r) => ({ ...r, results: r.results!.slice(0, results.length) })), {
    printedAt: "2026-10-29",
    metricColumns: opts.metrics ?? ["gf", "ga", "gd"],
    resultColumns: results,
    i18n: { standingsHeaders: { team: "Team", points: "Pts", metrics: opts.metrics ?? ["GF", "GA", "GD"] } },
  });
  return { ...(heading === undefined ? {} : { heading }), ...model.sections[0]! };
}
const standings = (...sections: DocSection[]): DocModel => ({ ...buildStandings("Open League", [], { printedAt: "2026-10-29" }), sections });
const E = Array.from({ length: 8 }, (_, i) => `E${i + 1}`);

/** Each table's header row as drawn (8.5pt runs sharing a baseline), in drawing order, left to right. */
async function headerRows(model: DocModel): Promise<PdfTextRun[][]> {
  const rows = new Map<string, PdfTextRun[]>();
  for (const r of pdfTextRuns(await docModelToPdf(model))) {
    if (r.size !== HEADER_SIZE) continue;
    const key = `${r.page}:${Math.round(r.y)}`;
    (rows.get(key) ?? rows.set(key, []).get(key)!).push(r);
  }
  return [...rows.values()].map((rs) => rs.sort((a, b) => a.x - b.x));
}
const bodyRuns = async (model: DocModel) => pdfTextRuns(await docModelToPdf(model)).filter((r) => r.size === BODY_SIZE);

/** A right-aligned header's column right edge: its text ends 4pt inside it. */
const rightEdge = (r: PdfTextRun) => r.x + measure(r.text, HEADER_SIZE) + CELL_INSET;

describe("doc-render standings grid (parity item 5)", () => {
  it("short names: every count column is no wider than its own measured header or widest cell plus a little room, and no narrower; Team takes the rest", async () => {
    const model = standings(table(undefined, E));
    const [head] = await headerRows(model);
    const cells = await bodyRuns(model);
    expect(head!.map((r) => r.text), "premise: the header row drew whole").toEqual(model.sections[0]!.table!.columns);
    let checked = 0;
    // columns 3… (the first count column's left edge is Team's right edge, which no run states)
    for (let i = 3; i < head!.length; i++) {
      const col = head![i]!;
      const w = rightEdge(col) - rightEdge(head![i - 1]!);
      // the widest text the column holds: its header, or a cell under it (a cell is right-aligned to the same edge)
      const under = cells.filter((c) => Math.abs(c.x + measure(c.text, BODY_SIZE) + CELL_INSET - rightEdge(col)) < 0.6).map((c) => measure(c.text, BODY_SIZE));
      const content = Math.max(measure(col.text, HEADER_SIZE), ...under) + 2 * CELL_INSET;
      expect(under.length, `${col.text}: a cell per row read back under it`).toBe(E.length);
      expect(w, `${col.text}: not narrower than its content`).toBeGreaterThanOrEqual(content - 0.01);
      expect(w, `${col.text}: no wider than its content plus a little room (it was ~a Team column's share)`).toBeLessThanOrEqual(content + ROOM);
      checked++;
    }
    expect(checked, "anti-vacuity: count columns checked (P W D L GF GA GD Pts, less the first)").toBe(7);
    // Team (the left-aligned header) begins just after `#` and gets most of the page: 8 short names, so the counts are narrow
    const team = head![1]!;
    const teamRight = rightEdge(head![2]!) - (rightEdge(head![3]!) - rightEdge(head![2]!)); // P's left edge, from W's width ≈ P's
    expect(teamRight - (team.x - CELL_INSET), "Team's column takes over half the page").toBeGreaterThan(CONTENT * 0.5);
  });

  it("two pools, one with a D column and one without: # and Team begin at the same x in both, and Pts stands against the page edge in both", async () => {
    const withD = table("Groups — Group A", ["Ridge VC", "Coastal Spikers", "Metro Smash", "Valley Setters"]);
    const noD = table("Groups — Group B", ["Ridge VC", "Coastal Spikers", "Metro Smash", "Valley Setters"], { results: ["P", "W", "L"] });
    expect(withD.table!.columns, "premise: the two pools print different columns").not.toEqual(noD.table!.columns);
    expect(withD.table!.columns.length - noD.table!.columns.length, "premise: A has the one extra column, D").toBe(1);
    const [a, b] = (await headerRows(standings(withD, noD))) as [PdfTextRun[], PdfTextRun[]];
    expect(a.map((r) => r.text)).toEqual(withD.table!.columns);
    expect(b.map((r) => r.text)).toEqual(noD.table!.columns);
    expect(rightEdge(b[0]!), "# stands at the same x in both").toBeCloseTo(rightEdge(a[0]!), 1);
    expect(b[1]!.x, "Team begins at the same x in both").toBeCloseTo(a[1]!.x, 1);
    expect(rightEdge(b.at(-1)!), "Pts: against the page edge in B").toBeCloseTo(A4_PORTRAIT - MARGIN, 1);
    expect(rightEdge(a.at(-1)!), "Pts: against the page edge in A").toBeCloseTo(A4_PORTRAIT - MARGIN, 1);
    // and the body: each pool's names begin at that x
    const names = (await bodyRuns(standings(withD, noD))).filter((r) => r.text === "Ridge VC");
    expect(names.map((r) => r.x), "the first row's name begins at the same x in both").toEqual([names[0]!.x, names[0]!.x].map((x) => expect.closeTo(x, 1)));
  });

  it("`#` is one fixed width: a pool of twelve (two-digit places) and a pool of four put it at the same right edge", async () => {
    const twelve = table("Groups — Group A", Array.from({ length: 12 }, (_, i) => `Team ${i + 1}`));
    const four = table("Groups — Group B", ["Alpha", "Bravo", "Charlie", "Delta"]);
    // the same columns, so the document's shared grid applies to both; give B different ones too, so the rule is `#`'s own
    const other = table("Groups — Group C", ["Alpha", "Bravo"], { results: ["P", "W", "L"], metrics: [] });
    const rows = await headerRows(standings(twelve, four, other));
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(rightEdge(r[0]!), `${r.map((x) => x.text).join(" ")}: # right edge`).toBeCloseTo(rightEdge(rows[0]![0]!), 1);
  });

  it("a header is never narrower than itself: a long metric header prints whole, whatever cap the cells are held to", async () => {
    const LONG = "Unusually long metric header";
    const model = standings(table(undefined, E.slice(0, 3), { metrics: ["gf"], rows: (n, i) => row(n, i, { metrics: { gf: 12 } }) }));
    model.sections[0]!.table!.columns[model.sections[0]!.table!.columns.indexOf("gf")] = LONG; // the caller's own header text
    const [head] = await headerRows(model);
    expect(head!.map((r) => r.text), "the long header drew whole, not ellipsised").toContain(LONG);
    const run = head!.find((r) => r.text === LONG)!;
    expect(rightEdge(run), "and inside the page").toBeLessThanOrEqual(A4_PORTRAIT - MARGIN + 0.01);
  });

  it("a runaway cell cannot take the page: a count column holding a 60-character text is held to exactly the cap, the cap is under a fifth of the page, and Team keeps the rest", async () => {
    const RUNAWAY = "x".repeat(60);
    const model = standings(table(undefined, E.slice(0, 3), { rows: (n, i) => row(n, i, { metrics: { gf: 12, ga: 4, gd: RUNAWAY as unknown as number } }) }));
    const [head] = await headerRows(model);
    const gd = head!.find((r) => r.text === "GD")!;
    const prev = head![head!.indexOf(gd) - 1]!;
    expect(measure(RUNAWAY, BODY_SIZE), "premise: the text itself is far wider than the cap").toBeGreaterThan(COUNT_CAP * 2);
    expect(measure("GD", HEADER_SIZE) + 2 * CELL_INSET, "premise: the header is narrower than the cap, so the cap is what binds").toBeLessThan(COUNT_CAP);
    expect(rightEdge(gd) - rightEdge(prev), "the runaway column is exactly the cap wide").toBeCloseTo(COUNT_CAP, 1);
    expect(COUNT_CAP, "and the cap is a small share of the page: under a fifth").toBeLessThan(CONTENT / 5);
    const team = head![1]!;
    expect(rightEdge(head![2]!) - (team.x - CELL_INSET), "Team still has its room: P's right edge less Team's left edge").toBeGreaterThan(CONTENT * 0.4);
  });

  it("derived columns (NRR, a ratio …) are set as numbers: text such as +0.412, ∞ and — stands against its column's right edge like the counts", async () => {
    const TEXT = ["+0.412", "∞", "—", "1.25"];
    const model = buildStandings("t", E.slice(0, 4).map((n, i) => ({ ...row(n, i), derived: [TEXT[i]!] })), {
      printedAt: "2026-10-29", metricColumns: ["gf", "ga", "gd"], resultColumns: ["P", "W", "D", "L"], derivedColumns: ["NRR"],
    });
    const doc = standings(model.sections[0]!);
    const [head] = await headerRows(doc);
    const nrr = head!.at(-1)!;
    expect(nrr.text, "premise: NRR is the last column, after Pts").toBe("NRR");
    expect(head!.at(-2)!.text, "premise: Pts is just before it").toBe("Pts");
    const under = (await bodyRuns(doc)).filter((r) => TEXT.includes(r.text));
    expect(under.map((r) => r.text).sort(), "anti-vacuity: the four derived cells drew").toEqual([...TEXT].sort());
    for (const c of under) expect(c.x + measure(c.text, BODY_SIZE) + CELL_INSET, `${c.text}: right-aligned to its column`).toBeCloseTo(rightEdge(nrr), 0);
  });
});

// The other tables keep the grid they had. The literals below are the x of every header run and of the first row's runs,
// recorded on the renderer as it stood BEFORE the standings rule (`doc-render.ts` at 96539ce4cb: the proportional share by
// character count, with #1057's floors). `standings-headers` is a table that prints the SAME headers a standings table does
// under another document kind, so a rule that leaked past the standings kind would move it.
describe("doc-render: tables that are not standings keep the proportional grid (positions recorded before the standings rule)", () => {
  const fixtures = [
    { id: "f1", at: "2026-10-29T09:00:00Z", court: "Court 1", stageName: "Groups", round: 1, home: "Ridge VC", away: "Coastal Spikers" },
    { id: "f2", at: "2026-10-29T10:00:00Z", court: "Court 2", stageName: "Groups", round: 1, home: "E3", away: "E4" },
  ];
  const models: Record<string, DocModel> = {
    "standings-headers": { ...standings(table(undefined, E)), kind: "timetable" },
    timetable: buildTimetable("Open — Timetable", fixtures, { printedAt: "2026-10-29" }),
    roster: buildRoster("Open — Rosters", [{ teamName: "E1", players: [{ name: "Ada Lovelace", dob: "2014-01-01", number: 7 }, { name: "Bo", number: 9 }] }], { printedAt: "2026-10-29" }),
    participants: buildParticipants("Open — Participants", [{ club: "Ridge VC", team: "E1", division: "Open", entrant: "E1", player: "Ada Lovelace", number: 7, position: "Player" }], { printedAt: "2026-10-29" }),
  };

  /** Each table's header-row x and first body row's x, 0.1pt. */
  async function positions(model: DocModel): Promise<{ header: number[]; row: number[] }> {
    const runs = pdfTextRuns(await docModelToPdf(model));
    const head = (await headerRows(model))[0]!;
    const y = head[0]!.y;
    const first = runs.filter((r) => r.size === BODY_SIZE && r.page === head[0]!.page && r.y > y).sort((a, b) => a.y - b.y || a.x - b.x);
    const firstY = first[0]!.y;
    const r1 = (n: number) => Math.round(n * 10) / 10;
    return { header: head.map((r) => r1(r.x)), row: first.filter((r) => Math.abs(r.y - firstY) < 1).map((r) => r1(r.x)) };
  }

  it("each model's header and first row stand where they stood", async () => {
    const out: Record<string, { header: number[]; row: number[] }> = {};
    for (const [label, model] of Object.entries(models)) out[label] = await positions(model);
    if (process.env.RECORD_POSITIONS) console.log("RECORDED", JSON.stringify(out));
    expect(Object.keys(out), "anti-vacuity: every model laid out").toHaveLength(Object.keys(RECORDED).length);
    for (const [label, got] of Object.entries(out)) expect(got.header.length, `${label}: a header row was read back`).toBeGreaterThan(2);
    expect(out).toEqual(RECORDED);
  });
});

const RECORDED: Record<string, { header: number[]; row: number[] }> = {
  "standings-headers": { header: [80.5, 93.9, 196.8, 243.8, 295.8, 347, 390.3, 439.4, 488.9, 538.2], row: [81.7, 93.9, 196.5, 247.9, 297.8, 347.6, 392.1, 445.8, 495.9, 541.5] },
  "timetable": { header: [44, 218.7, 279.8, 375.9, 506.9], row: [44, 218.7, 279.8, 349.7, 375.9, 506.9] },
  "roster": { header: [76.1, 89.5, 396.7, 512.2], row: [76.3, 89.5, 366] },
  "participants": { header: [44, 126.4, 167.7, 250.1, 322.3, 463.4, 476.8], row: [44, 126.4, 167.7, 250.1, 322.3, 463.7, 476.8] },
};
