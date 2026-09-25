// Scorer sheets §4.4 — the renderer, read back out of its own bytes with the
// shared reader (e2e/pdf-uris.ts): pages, link annotations and their areas,
// the decoded text of every line (the embedded fonts carry ToUnicode maps),
// every stroked line and image — and each card's QR, rasterised the way a
// printer and a camera see it and read by a real decoder (_sheet-raster.ts).
//
// The page (owner-approved 2026-09-24): A4 portrait, 8 mm edges, a 3×3 grid
// of cut-out cards in time order left→right then top→bottom; per card the
// time, the board's match code, the division, both sides, and a branded QR
// (ECL H, solid rounded navy finders, the Seazn icon 12 mm in the centre).
import fs from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import QRCode from "qrcode";
import { ROWS_PER_PAGE } from "@/lib/scorer-sheets";
import { log } from "@/server/logger";
import { renderScorerSheetPdf } from "../scorer-sheet-pdf";
import { pdfImages, pdfLines, pdfLinkUris, pdfLinks, pdfPageCount, pdfPageSvg, pdfTextRuns } from "../../../e2e/pdf-uris";
import { CONDITIONS, decodeEveryCard, lumaAt, rasterPage, type Condition } from "./_sheet-raster";
import { header, labels, model, row, rows, token, useBrandFonts } from "./_sheet-fixtures";

beforeAll(useBrandFonts);

const MM = 72 / 25.4;
const PAGE_W = 595.28;
const EDGE = 8 * MM;
const CARD_W = (PAGE_W - 2 * EDGE) / 3;
/** The tallest header the sheet can have: the Pro masthead and a title long
 *  enough to wrap — so the smallest cards, and the smallest QR codes. */
const LONG_TITLE = "Northern Counties Inter-Club Badminton Championships — Autumn Series Finals 2026";
const tallHeader = { ...header, title: LONG_TITLE, branding: { orgName: "Riverside Shuttlers", logos: [] } };

const round2 = (n: number) => Math.round(n * 100) / 100;
/** 0, 1, 2 … by position among the distinct values, smallest first. */
const ranks = (values: number[]) => {
  const distinct = [...new Set(values.map(round2))].sort((a, b) => a - b);
  return values.map((v) => distinct.indexOf(round2(v)));
};

describe("renderScorerSheetPdf — the 3×3 card grid (scorer sheets §4.4)", () => {
  it("is a PDF with one page per model page", async () => {
    const pdf = await renderScorerSheetPdf(model([rows(2), rows(1, 3)]));
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdfPageCount(pdf)).toBe(2);
  });

  it("every card carries exactly one link to its own URL, in order — tappable when opened on a phone", async () => {
    const page = rows(9);
    expect(pdfLinkUris(await renderScorerSheetPdf(model([page])))).toEqual(page.map((r) => r.url));
  });

  it("lays the cards out left→right, then top→bottom, three by three — each card's text inside its own cell", async () => {
    const page = rows(9);
    const pdf = await renderScorerSheetPdf(model([page]));
    const links = pdfLinks(pdf);
    expect(links).toHaveLength(9);
    const cols = ranks(links.map((l) => l.x));
    const rowsOf = ranks(links.map((l) => l.top));
    expect(links.map((_, i) => [cols[i], rowsOf[i]])).toEqual(page.map((_, i) => [i % 3, Math.floor(i / 3)]));
    // The name printed on card i sits in card i's column, above card i's QR
    // and below the QR of the row above it.
    const runs = pdfTextRuns(pdf);
    for (const [i, r] of page.entries()) {
      const name = runs.find((t) => t.text === r.home)!;
      const qr = links[i]!;
      expect(Math.floor((name.x - EDGE) / CARD_W)).toBe(i % 3);
      expect(name.y).toBeLessThan(qr.top);
      if (i >= 3) expect(name.y).toBeGreaterThan(links[i - 3]!.top + links[i - 3]!.height);
    }
  });

  it("a court's second page starts again at the top-left card, under its own heading", async () => {
    const pdf = await renderScorerSheetPdf({
      ...model([]),
      pages: [
        { heading: "Court 1 · page 1 of 2", rows: rows(9) },
        { heading: "Court 1 · page 2 of 2", rows: rows(1, 10) },
      ],
    });
    const links = pdfLinks(pdf);
    expect(links.map((l) => l.page)).toEqual([...Array(9).fill(1), 2]);
    expect(round2(links[9]!.x)).toBe(round2(links[0]!.x));
    expect(round2(links[9]!.top)).toBe(round2(links[0]!.top));
    const onPage = (n: number) => pdfTextRuns(pdf).filter((r) => r.page === n).map((r) => r.text);
    expect(onPage(1)).toContain("COURT 1 · PAGE 1 OF 2");
    expect(onPage(2)).toContain("COURT 1 · PAGE 2 OF 2");
  });

  it("a Pro org's masthead heads EVERY page — page 2 of a court, cut and handed out, still says whose event it is — and the cards start at the same place", async () => {
    const branded = { ...header, branding: { orgName: "Riverside Shuttlers", logos: [] } };
    const pdf = await renderScorerSheetPdf({
      ...model([], { header: branded }),
      pages: [
        { heading: "Court 1 · page 1 of 2", rows: rows(9) },
        { heading: "Court 1 · page 2 of 2", rows: rows(1, 10) },
      ],
    });
    const org = pdfTextRuns(pdf).filter((r) => r.text === "RIVERSIDE SHUTTLERS");
    expect(org.map((r) => r.page)).toEqual([1, 2]);
    expect(round2(org[1]!.y)).toBe(round2(org[0]!.y));
    const links = pdfLinks(pdf);
    expect(round2(links[9]!.top)).toBe(round2(links[0]!.top));
  });

  it("every page prints its own heading and the check-names line — the courtless section included", async () => {
    const pdf = await renderScorerSheetPdf({
      ...model([]),
      pages: [
        { heading: "Court 1 · page 1 of 1", rows: [row(1)] },
        { heading: "No court assigned · page 1 of 1", rows: [row(2)] },
      ],
    });
    const onPage = (n: number) => pdfTextRuns(pdf).filter((r) => r.page === n).map((r) => r.text);
    expect([1, 2].map((n) => onPage(n).filter((t) => t === labels.checkNames).length)).toEqual([1, 1]);
    expect(onPage(1)).toContain("COURT 1 · PAGE 1 OF 1");
    expect(onPage(2)).toContain("NO COURT ASSIGNED · PAGE 1 OF 1");
  });

  it.each(Object.keys(CONDITIONS) as Condition[])(
    "every card's QR, cut from the page raster, decodes to ITS OWN row's URL — %s, tallest header, 9 + 1 cards, a TBD side",
    async (condition) => {
      const pages = [rows(8).concat(row(9, { home: "Winner of QF·2", homeTbd: true })), rows(1, 10)];
      for (const h of [header, tallHeader]) {
        const pdf = await renderScorerSheetPdf({ ...model(pages), header: h });
        expect(await decodeEveryCard(pdf, condition)).toEqual(pages.flat().map((r) => r.url));
      }
    },
  );

  // The owner-approved finder SHAPE (B2), pinned as geometry. Radius 1.0 missed
  // 2/9 at 90 dpi on the prototype's symbol size but decodes 10/10 at these
  // (poppler and librsvg, every condition — measured 2026-09-24): the miss
  // depends on where module edges fall on the pixel grid, so no decode test
  // can hold the approved 2.0.
  it("draws each finder as the approved rounded square: outer radius 2 modules, a 1-module ring, a 0.6-radius centre", async () => {
    const pdf = await renderScorerSheetPdf(model([rows(3)]));
    const moves = [...pdfPageSvg(pdf, 1, () => "").matchAll(/M([\d.-]+),([\d.-]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    const drawnAt = (x: number, y: number) => moves.some(([mx, my]) => Math.abs(mx! - x) < 0.01 && Math.abs(my! - y) < 0.01);
    const missing: string[] = [];
    for (const [i, qr] of pdfLinks(pdf).entries()) {
      const n = QRCode.create(qr.uri, { errorCorrectionLevel: "H" }).modules.size;
      const mod = qr.width / n;
      // pdfkit starts a rounded rectangle at (left + radius, top).
      for (const [fx, fy] of [[qr.x, qr.top], [qr.x + (n - 7) * mod, qr.top], [qr.x, qr.top + (n - 7) * mod]] as const) {
        if (!drawnAt(fx + 2 * mod, fy)) missing.push(`card ${i + 1} outer`);
        if (!drawnAt(fx + mod + 1 * mod, fy + mod)) missing.push(`card ${i + 1} ring`);
        if (!drawnAt(fx + 2 * mod + 0.6 * mod, fy + 2 * mod)) missing.push(`card ${i + 1} centre`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("centres the Seazn icon on every QR at 12 mm, embedded once for the whole sheet", async () => {
    const pdf = await renderScorerSheetPdf(model([rows(9), rows(2, 10)]));
    const icons = pdfImages(pdf);
    const links = pdfLinks(pdf);
    expect(icons).toHaveLength(11);
    expect(new Set(icons.map((i) => i.xobject)).size).toBe(1);
    for (const [i, icon] of icons.entries()) {
      const qr = links[i]!;
      expect(icon.width).toBeCloseTo(12 * MM, 2);
      expect(icon.height).toBeCloseTo(12 * MM, 2);
      expect(icon.x + icon.width / 2).toBeCloseTo(qr.x + qr.width / 2, 2);
      expect(icon.top + icon.height / 2).toBeCloseTo(qr.top + qr.height / 2, 2);
    }
  });

  it("without the icon file (a broken deploy) prints plain, full QR codes that still decode — never a failed print", async () => {
    const real = fs.existsSync;
    const exists = vi.spyOn(fs, "existsSync").mockImplementation((p) => !String(p).endsWith("logo-square.png") && real(p));
    // The broken deploy is told to the operator once per print, as a warning —
    // captured so this expected line does not print into the run.
    const warned = vi.spyOn(log, "warn").mockImplementation(() => undefined as never);
    try {
      const page = rows(3);
      const pdf = await renderScorerSheetPdf(model([page]));
      expect(exists).toHaveBeenCalled();
      expect(warned).toHaveBeenCalledTimes(1);
      expect(warned).toHaveBeenCalledWith(
        { cwd: process.cwd() },
        "scorer sheets: logo-square.png not found; printing QR codes without the centre icon",
      );
      expect(pdfImages(pdf)).toEqual([]);
      expect(await decodeEveryCard(pdf, "dpi90")).toEqual(page.map((r) => r.url));
      // No knock-out either: the centre of each symbol keeps its data modules.
      const raster = await rasterPage(pdf, 1, "dpi90");
      const centres = pdfLinks(pdf).map((l) => {
        const [cx, cy, half] = [l.x + l.width / 2, l.top + l.height / 2, 4 * MM];
        let dark = 0;
        for (let dx = -half; dx <= half; dx += 0.5) for (let dy = -half; dy <= half; dy += 0.5) if (lumaAt(raster, cx + dx, cy + dy) < 100) dark++;
        return dark > 0;
      });
      expect(centres).toEqual([true, true, true]);
    } finally {
      exists.mockRestore();
      warned.mockRestore();
    }
  });

  it("keeps at least one module of white round the icon — the data modules stop short of it", async () => {
    const pdf = await renderScorerSheetPdf(model([rows(9)]));
    const raster = await rasterPage(pdf, 1, "dpi90");
    const links = pdfLinks(pdf);
    /** Luma samples round the icon, `d` points outside its edge. */
    const ring = (icon: { x: number; top: number; width: number; height: number }, d: number) => {
      const [x0, y0, x1, y1] = [icon.x - d, icon.top - d, icon.x + icon.width + d, icon.top + icon.height + d];
      const out: number[] = [];
      for (let t = 0; t <= 1; t += 1 / 40) {
        const x = x0 + t * (x1 - x0);
        const y = y0 + t * (y1 - y0);
        out.push(lumaAt(raster, x, y0), lumaAt(raster, x, y1), lumaAt(raster, x0, y), lumaAt(raster, x1, y));
      }
      return out;
    };
    const padDark: string[] = [];
    let beyondDark = 0;
    for (const [i, icon] of pdfImages(pdf).entries()) {
      const mod = links[i]!.width / QRCode.create(links[i]!.uri, { errorCorrectionLevel: "H" }).modules.size;
      // The middle of a one-module pad must be paper…
      if (ring(icon, mod / 2).some((l) => l < 200)) padDark.push(`card ${i + 1}`);
      // …while three modules out the data modules are there to be missed.
      beyondDark += ring(icon, 3 * mod).filter((l) => l < 100).length;
    }
    expect(padDark).toEqual([]);
    expect(beyondDark).toBeGreaterThan(9 * 20);
  });

  it("keeps four modules of white between each QR and the text above it, the cut line below and the side cuts", async () => {
    const long = "Riverside Shuttlers Badminton Club Seniors";
    const page = rows(9).map((r) => ({ ...r, away: long }));
    const pdf = await renderScorerSheetPdf({ ...model([page]), header: tallHeader });
    const links = pdfLinks(pdf);
    const runs = pdfTextRuns(pdf);
    const lines = pdfLines(pdf);
    const cutsY = lines.filter((l) => l.y1 === l.y2 && round2(l.x2 - l.x1) === round2(PAGE_W)).map((l) => l.y1);
    const cutsX = lines.filter((l) => l.x1 === l.x2).map((l) => l.x1);
    const short: string[] = [];
    for (const [i, qr] of links.entries()) {
      const mod = qr.width / QRCode.create(qr.uri, { errorCorrectionLevel: "H" }).modules.size;
      const bottom = qr.top + qr.height;
      const cutBelow = Math.min(...cutsY.filter((y) => y > bottom));
      const cutAbove = Math.max(...cutsY.filter((y) => y < qr.top));
      const cutLeft = Math.max(...cutsX.filter((x) => x < qr.x));
      const cutRight = Math.min(...cutsX.filter((x) => x > qr.x + qr.width));
      // Text in this card, above the symbol: its lowest descender (Inter's is 0.242 em).
      const textBottom = Math.max(
        ...runs.filter((r) => r.x > cutLeft && r.x < cutRight && r.y > cutAbove && r.y < qr.top).map((r) => r.y + 0.25 * r.size),
      );
      const gaps = {
        text: qr.top - textBottom,
        below: cutBelow - bottom,
        left: qr.x - cutLeft,
        right: cutRight - (qr.x + qr.width),
      };
      for (const [side, gap] of Object.entries(gaps)) {
        if (!(gap >= 4 * mod)) short.push(`card ${i + 1} ${side}: ${(gap / mod).toFixed(2)} modules`);
      }
    }
    expect(links).toHaveLength(9);
    expect(short).toEqual([]);
  });

  it("prints only the card's own facts — no token or URL, and no score, winner or umpire lines", async () => {
    const pdf = await renderScorerSheetPdf(model([[row(1)]]));
    const texts = pdfTextRuns(pdf).map((r) => r.text);
    expect([...texts].sort()).toEqual(
      [
        labels.eyebrow,
        header.title.toUpperCase(),
        header.description!,
        "COURT 1 · PAGE 1 OF 1",
        labels.checkNames,
        "10:30",
        "QF·1",
        "Open Singles",
        "Home 1",
        "Away 1",
        header.meta.printedAt,
        "seazn.club",
      ].sort(),
    );
    // Nor anywhere in the uncompressed bytes (document info, annotations)
    // other than the card's own link, which a printout does not show.
    const outsideLinks = pdf.toString("latin1").replace(/\/URI\s*\((?:\\.|[^\\)])*\)/g, "");
    expect(outsideLinks).not.toContain(token(1));
    expect(outsideLinks).not.toContain("/score/");
  });

  it("strokes only cut lines and one short divider per card — no pen lines on a named card", async () => {
    const pdf = await renderScorerSheetPdf(model([rows(7)]));
    const lines = pdfLines(pdf);
    const isCut = (l: (typeof lines)[number]) =>
      (l.y1 === l.y2 && round2(l.x1) === 0 && round2(l.x2) === round2(PAGE_W)) ||
      (l.x1 === l.x2 && [0, 1, 2, 3].some((k) => round2(l.x1) === round2(EDGE + k * CARD_W)));
    const dividers = lines.filter((l) => !isCut(l));
    expect(lines.filter(isCut).length).toBeGreaterThan(0);
    expect(dividers.map((l) => round2(l.x2 - l.x1))).toEqual(Array(7).fill(24));
  });

  it("a TBD side keeps its card and QR (D2), and prints its slot label over a pen line the card's width", async () => {
    const pdf = await renderScorerSheetPdf(model([[row(1, { home: "Winner of QF·2", homeTbd: true })]]));
    expect(pdfLinkUris(pdf)).toHaveLength(1);
    const runs = pdfTextRuns(pdf);
    const label = runs.find((r) => r.text === "Winner of QF·2")!;
    const named = runs.find((r) => r.text === "Away 1")!;
    // Longer than the 24pt divider between the sides, which every card has.
    const under = (run: { x: number; y: number }) =>
      pdfLines(pdf).filter(
        (l) => l.y1 === l.y2 && round2(l.x1) === round2(run.x) && l.x2 - l.x1 > 24 && l.y1 > run.y && l.y1 - run.y < 20,
      );
    expect(under(label).map((l) => round2(l.x2 - l.x1))).toEqual([round2(CARD_W - 20)]);
    expect(under(named)).toEqual([]);
  });

  it("a pair prints one member per line; a long member is cut on its own line", async () => {
    const long = "Maximiliana Alejandra Fernández de Villanueva y Hartley-Okonkwo";
    const pdf = await renderScorerSheetPdf(
      model([
        [
          row(1, {
            home: "Ana Silva / Ben Cole",
            homePair: ["Ana Silva", "Ben Cole"],
            away: `${long} / Zoë Li`,
            awayPair: [long, "Zoë Li"],
          }),
        ],
      ]),
    );
    const runs = pdfTextRuns(pdf);
    const at = (text: string) => runs.filter((r) => r.text === text);
    expect(at("Ana Silva / Ben Cole")).toEqual([]);
    const [ana, ben] = [at("Ana Silva")[0]!, at("Ben Cole")[0]!];
    expect(ben.x).toBe(ana.x);
    expect(ben.y - ana.y).toBeCloseTo(9 * 1.21, 1);
    const cut = runs.filter((r) => r.text.startsWith("Maximiliana"));
    expect(cut).toHaveLength(1);
    expect(cut[0]!.text.endsWith("…")).toBe(true);
    expect(at("Zoë Li")).toHaveLength(1);
  });

  it("a long name wraps onto a second line, then is cut with an ellipsis — never a third line", async () => {
    const fits = "Riverside Shuttlers Badminton Club Seniors";
    const absurd = Array.from({ length: 4 }, () => "Maximiliana Fernández de Villanueva").join(" ");
    const runs = pdfTextRuns(await renderScorerSheetPdf(model([[row(1, { home: fits }), row(2, { home: absurd })]])));
    // Below the header (whose description is 9pt too), in the card's column.
    const headerBottom = runs.find((r) => r.text === labels.checkNames)!.y;
    const linesOf = (card: number) =>
      runs.filter(
        (r) => r.size === 9 && r.y > headerBottom && Math.floor((r.x - EDGE) / CARD_W) === card && !/^Away /.test(r.text),
      );
    const joined = (runs: { text: string }[]) => runs.map((r) => r.text.trim()).join(" ");
    const whole = linesOf(0);
    expect(whole).toHaveLength(2);
    expect(joined(whole)).toBe(fits);
    const cut = linesOf(1);
    expect(cut).toHaveLength(2);
    expect(cut[1]!.text.endsWith("…")).toBe(true);
    expect(absurd.startsWith(joined(cut).slice(0, -1).trimEnd())).toBe(true);
  });

  it("nine cards stay on one page, clear of the footer, under the tallest header — the title held to two lines", async () => {
    const pdf = await renderScorerSheetPdf({ ...model([rows(9)]), header: tallHeader });
    const runs = pdfTextRuns(pdf);
    expect(runs.map((r) => r.text)).toContain("RIVERSIDE SHUTTLERS");
    const title = runs.filter((r) => r.size === 26);
    expect(title).toHaveLength(2);
    expect(title[1]!.text.endsWith("…")).toBe(true);
    expect(pdfPageCount(pdf)).toBe(1);
    const foot = runs.find((r) => r.text === header.meta.printedAt)!;
    const footTop = foot.y - foot.size;
    expect(Math.max(...runs.filter((r) => r.y !== foot.y).map((r) => r.y))).toBeLessThan(footTop);
    const links = pdfLinks(pdf);
    expect(links).toHaveLength(9);
    expect(Math.max(...links.map((l) => l.top + l.height))).toBeLessThan(footTop);
    const check = runs.find((r) => r.text === labels.checkNames)!;
    expect(Math.min(...links.map((l) => l.top))).toBeGreaterThan(check.y);
  });

  it("an overlong heading is cut on its one line, never wrapped", async () => {
    const heading = Array.from({ length: 8 }, () => "Court Philippe-Chatrier").join(" ");
    const runs = pdfTextRuns(await renderScorerSheetPdf({ ...model([]), pages: [{ heading, rows: [row(1)] }] }));
    const cut = runs.filter((r) => r.text.startsWith("COURT PHILIPPE"));
    expect(cut).toHaveLength(1);
    expect(cut[0]!.text.endsWith("…")).toBe(true);
    expect(runs.filter((r) => /^(PHILIPPE|CHATRIER)/.test(r.text))).toEqual([]);
  });

  it("refuses a page longer than ROWS_PER_PAGE rather than spill it onto a stray page", async () => {
    expect(pdfPageCount(await renderScorerSheetPdf(model([rows(ROWS_PER_PAGE)])))).toBe(1);
    await expect(renderScorerSheetPdf(model([rows(ROWS_PER_PAGE + 1)]))).rejects.toThrow(
      `A sheet page holds at most ${ROWS_PER_PAGE} rows; got ${ROWS_PER_PAGE + 1}`,
    );
  });

  it("a QR that cannot be encoded fails the whole print — never a card without a code", async () => {
    const tooLong = `https://example.test/score/${"x".repeat(3000)}`;
    await expect(renderScorerSheetPdf(model([[row(1), row(2, { url: tooLong })]]))).rejects.toThrow(
      /QR generation failed for fixture f2/,
    );
  });
});
