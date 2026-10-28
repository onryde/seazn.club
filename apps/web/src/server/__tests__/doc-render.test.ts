import { describe, it, expect, vi } from "vitest";

// Font-encoding-proof spy: records every draw call by intercepting pdfkit.
const rec = { text: [] as string[], images: 0, fills: [] as string[], strokes: [] as string[], cells: [] as { text: string; x: number; align?: string }[] };
vi.mock("pdfkit", () => {
  class FakeDoc {
    page = { width: 595.28, height: 841.89 };
    y = 40;
    private endCb?: () => void;
    on(ev: string, cb: () => void) { if (ev === "end") this.endCb = cb; return this; }
    registerFont() { return this; }
    font() { return this; } fontSize() { return this; }
    fillColor() { return this; }
    strokeColor(c?: string) { if (typeof c === "string") rec.strokes.push(c); return this; }
    lineWidth() { return this; }
    text(s: unknown, x?: number, _y?: number, o?: { align?: string }) {
      rec.text.push(String(s));
      rec.cells.push({ text: String(s), x: x ?? NaN, ...(o?.align !== undefined ? { align: o.align } : {}) });
      return this;
    }
    image() { rec.images++; return this; }
    rect() { return this; } roundedRect() { return this; } circle() { return this; }
    moveTo() { return this; } lineTo() { return this; } stroke() { return this; }
    fill(c?: string) { if (typeof c === "string") rec.fills.push(c); return this; }
    dash() { return this; } undash() { return this; } moveDown() { return this; }
    addPage() { return this; } switchToPage() { return this; }
    widthOfString() { return 10; }
    bufferedPageRange() { return { start: 0, count: 1 }; }
    end() { this.endCb?.(); }        // resolves docModelToPdf's `done` after all drawing
  }
  return { default: FakeDoc };
});

import { docModelToPdf } from "../doc-render";
import { buildStandings, buildTimetable, type DocModel } from "@seazn/engine/exports";
import { pointsText } from "@seazn/engine/competition";

const model = (branding?: DocModel["branding"]): DocModel => ({
  kind: "timetable", title: "Summer League — Div 1",
  description: "All fixtures, in play order.",
  meta: { printedAt: "2026-07-19" },
  ...(branding ? { branding } : {}),
  sections: [{ table: { columns: ["Time", "Home"], rows: [["09:00", "Falcons"]] } }],
  pageBreaks: "auto",
});

async function render(m: DocModel) {
  rec.text = []; rec.images = 0; rec.fills = []; rec.strokes = []; rec.cells = [];
  await docModelToPdf(m);
  return rec;
}

describe("doc-render masthead", () => {
  it("draws a night masthead wordmark + lime pitch-line when branded (Pro chrome)", async () => {
    const r = await render(model({ orgName: "Riverside SC", colors: { primary: "#150b36" } }));
    expect(r.text.join(" ")).toContain("SEAZN");        // masthead wordmark
    expect(r.fills).toContain("#a3e635");               // lime pitch-line rule (the signature)
    expect(r.text.join(" ")).toContain("ORDER OF PLAY");
  });

  it("draws the red ball alongside the wordmark + lime line (the full mark)", async () => {
    // a timetable model has no other red element, so this is a clean,
    // non-tautological assertion for PALETTE.ball (#ef4444).
    const r = await render(model({ orgName: "Riverside SC", colors: { primary: "#150b36" } }));
    expect(r.fills).toContain("#ef4444");
  });

  it("free-tier: eyebrow + title upgrade for ALL, but NO masthead wordmark/pitch-line", async () => {
    const r = await render(model()); // no branding
    expect(r.text.join(" ")).toContain("ORDER OF PLAY"); // title block draws for everyone
    expect(r.text.join(" ")).toContain("Summer League — Div 1");
    expect(r.text.join(" ")).not.toContain("SEAZN");    // no night masthead when unbranded
    expect(r.fills).not.toContain("#a3e635");           // no pitch-line when unbranded
  });
});

describe("doc-render tables", () => {
  it("renders a night header row + data cells for a table", async () => {
    const r = await render(model()); // reuse the render() spy + timetable model
    expect(r.text.join(" ")).toContain("Time");     // header cell
    expect(r.text.join(" ")).toContain("Falcons");  // data cell
    expect(r.fills).toContain("#150b36");            // night header-row background
  });
});

// W2d follow-up (re-review §5): a chess table prints its points in half-points ("1½", FIDE's 1 / ½ / 0, RB2B-17), and the
// PDF must set that column as the number it is — right-aligned like every other count — not as text. The cells are the
// engine's own spelling (`pointsText` over stored half-points), never typed.
describe("doc-render tables: a points column in half-points aligns as a number", () => {
  /** Each column's alignment in the drawn table, read from the cells' draw calls (header row first). */
  async function alignments(m: DocModel): Promise<Record<string, string[]>> {
    const r = await render(m);
    const table = m.sections[0]!.table!;
    const out: Record<string, string[]> = {};
    for (const row of [table.columns, ...table.rows]) {
      // One draw call per cell, left to right; match them by text, in order, from the first header cell on.
      row.forEach((cell, i) => {
        const call = r.cells.find((c) => c.text === String(cell) && c.align !== undefined && !(c as { used?: boolean }).used);
        if (call === undefined) throw new Error(`no draw call for cell "${cell}"`);
        (call as { used?: boolean }).used = true;
        (out[table.columns[i]!] ??= []).push(call.align!);
      });
    }
    return out;
  }
  // FIDE: a win 1, a draw ½, a loss 0, stored in half-points (2 / 1 / 0): 1½ (one win, one draw), 2 (two wins), ½, 0.
  const chess = (stored: number[]) =>
    buildStandings(
      "Chess Open — Standings",
      stored.map((points, i) => ({ name: `Player ${i + 1}`, played: 2, won: 1, drawn: 1, lost: 0, points: pointsText(points, "half"), metrics: { wins: 1 } })),
      { printedAt: "2026-10-28", metricColumns: ["wins"] },
    );

  it("chess: the Pts column is right-aligned for 1½ and for 2, and every other column is set as it always was", async () => {
    const model = chess([3, 4, 1, 0]);
    expect(model.sections[0]!.table!.rows.map((r) => r.at(-1)), "premise: the engine's half-point spellings").toEqual(["1½", "2", "½", "0"]);
    const a = await alignments(model);
    expect(a["Pts"], "Pts, the header and all four cells").toEqual(Array(5).fill("right"));
    // Every other column: the counts right, the name left (as before this change).
    let checked = 0;
    for (const col of ["#", "P", "W", "D", "L", "wins"]) {
      expect(a[col], col).toEqual(Array(5).fill("right"));
      checked++;
    }
    expect(a["Team"], "Team").toEqual(Array(5).fill("left"));
    expect(checked + 2, "columns checked").toBe(model.sections[0]!.table!.columns.length);
  });

  it("a column that is only ½ steps is a number too; one with any word in it stays text (the positive pair)", async () => {
    expect((await alignments(chess([1, 1])))["Pts"]).toEqual(Array(3).fill("right"));
    // A timetable's columns, as before: the times and the score right (header with them), the names, the court and the
    // stage left — "Pool ½" carries a ½ AND a word, so it stays text.
    const tt = buildTimetable(
      "Cup",
      [{ id: "f1", at: "09:00", court: "Court 1", stageName: "Pool ½", round: 1, home: "Ash", away: "Birch", result: "2–1" }],
      { printedAt: "2026-10-28" },
    );
    const a = await alignments(tt);
    expect(a, "Time, Court, Home, result, Away, Stage").toEqual({
      Time: ["right", "right"], Court: ["left", "left"], Home: ["left", "left"], "": ["right", "right"], Away: ["left", "left"], Stage: ["left", "left"],
    });
  });
});

describe("doc-render footer", () => {
  it("footer groups sponsors by tier, title first", async () => {
    const r = await render(model({
      orgName: "Riverside SC",
      sponsors: [{ name: "Silverware Co", tier: "silver" }, { name: "Acme", tier: "title" }],
    }));
    // the sponsor line is one text call: "SPONSORS   Acme  ·  Silverware Co"
    const line = r.text.find((t) => t.includes("Acme") && t.includes("Silverware"));
    expect(line).toBeTruthy();
    expect(line!.indexOf("Acme")).toBeLessThan(line!.indexOf("Silverware")); // title before silver
  });

  it("carries a 'Powered by seazn.club' attribution on unbranded (free-tier) docs", async () => {
    const r = await render(model()); // no branding
    expect(r.text.join(" ")).toContain("seazn.club");
  });

  it("carries a 'Powered by seazn.club' attribution on branded (Pro) docs too", async () => {
    const r = await render(model({ orgName: "Riverside SC" }));
    expect(r.text.join(" ")).toContain("seazn.club");
  });
});

describe("doc-render tickets", () => {
  const ticketModel = (status: string): DocModel => ({
    kind: "admit_ticket", title: "Tickets", meta: { printedAt: "2026-07-19" },
    branding: { orgName: "Riverside SC" },
    sections: [{ columnsHint: 2, ticket: {
      maskedName: "S. Ref", competition: "Summer League", dates: "19 Jul",
      ref: "AB12CD", status, qrUrl: "https://x/r/AB12CD", seq: 1 } }],
    pageBreaks: "auto",
  });

  it("renders admit tickets with ref + ADMIT ONE", async () => {
    const r = await render(ticketModel("CONFIRMED")); // reuse the Task 4 render() spy
    expect(r.text.join(" ")).toContain("AB12CD");
    expect(r.text.join(" ")).toContain("ADMIT ONE");
    expect(r.images).toBeGreaterThan(0); // QR drawn
  });

  it("stamps a CONFIRMED ticket green, not the generic ball-red (Task 12b)", async () => {
    const r = await render(ticketModel("CONFIRMED"));
    // The stamp is a bordered chip (ticket.png's shape), so its colour is
    // stroked rather than filled — assert over both channels.
    expect([...r.fills, ...r.strokes]).toContain("#047857");
    // the brand ball itself is legitimately ball-red — one on the page
    // masthead (branded ticketModel) + one on the ticket card — but the
    // CONFIRMED stamp colour must never reuse ball-red, so no THIRD hit.
    expect(r.fills.filter((c) => c === "#ef4444")).toHaveLength(2);
  });

  it("stamps a WAITLISTED ticket blue (Task 12b)", async () => {
    // real domain value is "waitlisted" (registrations.status enum;
    // r/[ref]/ticket.png/route.tsx STAMP map) — not "waitlist".
    const r = await render(ticketModel("WAITLISTED"));
    expect([...r.fills, ...r.strokes]).toContain("#0369a1");
  });

  it("falls back to pending amber for an unrecognized status (Task 12b)", async () => {
    const r = await render(ticketModel("SOME_UNKNOWN_STATUS"));
    expect([...r.fills, ...r.strokes]).toContain("#b45309");
    // brand ball contributes two #ef4444 fills (masthead + ticket card, see
    // above); the fallback stamp colour itself must not add a third.
    expect(r.fills.filter((c) => c === "#ef4444")).toHaveLength(2);
  });

  it("carries the org name on the ticket card header, uppercased (Task 12b)", async () => {
    const r = await render(ticketModel("CONFIRMED"));
    // page masthead draws it once already — the card must carry a SECOND
    // copy (cut-out tickets lose the page masthead), so require >= 2 hits.
    const hits = r.text.filter((t) => t === "RIVERSIDE SC").length;
    expect(hits).toBeGreaterThanOrEqual(2);
  });
});

describe("doc-render xlsx", () => {
  it("xlsx header includes org name + sponsor row when branded", async () => {
    const { docModelToXlsx } = await import("../doc-render");
    const ExcelJS = (await import("exceljs")).default;
    const buf = await docModelToXlsx(model({ orgName: "Riverside SC", sponsors: [{ name: "Acme", tier: "title" }] }));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const cells = wb.worksheets[0].getSheetValues().flat().map(String).join(" ");
    expect(cells).toContain("Riverside SC");
    expect(cells).toContain("Acme");
  });
});
