// Scorer sheets §4.4 — the renderer, read back out of its own bytes with the
// shared reader (e2e/pdf-uris.ts): pages, link annotations, the decoded text
// of every line (the embedded fonts carry ToUnicode maps) and the QR images'
// pixels, decoded with a real QR decoder.
import { beforeAll, describe, expect, it } from "vitest";
import jsQR from "jsqr";
import sharp from "sharp";
import { ROWS_PER_PAGE } from "@/lib/scorer-sheets";
import { qrBuffer } from "../doc-theme";
import { renderScorerSheetPdf } from "../scorer-sheet-pdf";
import { pdfImages, pdfLines, pdfLinkUris, pdfPageCount, pdfTextRuns } from "../../../e2e/pdf-uris";
import { header, labels, model, row, token, useBrandFonts } from "./_sheet-fixtures";

beforeAll(useBrandFonts);

const decode = (img: { rgba: Uint8ClampedArray; pxWidth: number; pxHeight: number }) =>
  jsQR(img.rgba, img.pxWidth, img.pxHeight)?.data ?? null;

describe("renderScorerSheetPdf (scorer sheets §4.4)", () => {
  it("is a PDF with one page per model page", async () => {
    const pdf = await renderScorerSheetPdf(model([[row(1), row(2)], [row(3)]]));
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdfPageCount(pdf)).toBe(2);
  });

  it("every row carries exactly one link to its own URL, in order — tappable when opened on a phone", async () => {
    const rows = [row(1), row(2), row(3)];
    expect(pdfLinkUris(await renderScorerSheetPdf(model([rows])))).toEqual(rows.map((r) => r.url));
  });

  it("the QR printed on each row decodes to that row's own URL, in order (real decoder)", async () => {
    const pages = [[row(1), row(2)], [row(3)]];
    const images = pdfImages(await renderScorerSheetPdf(model(pages)));
    expect(images.map((i) => i.page)).toEqual([1, 1, 2]);
    expect(images.map(decode)).toEqual(pages.flat().map((r) => r.url));
  });

  it("a TBD side keeps its row and its QR (D2), and prints its slot label over a pen line", async () => {
    const pdf = await renderScorerSheetPdf(model([[row(1, { home: "Winner of QF·2", homeTbd: true })]]));
    expect(pdfLinkUris(pdf)).toHaveLength(1);
    expect(pdfImages(pdf).map(decode)).toEqual([row(1).url]);
    const runs = pdfTextRuns(pdf);
    const label = runs.find((r) => r.text === "Winner of QF·2")!;
    const named = runs.find((r) => r.text === "Away 1")!;
    // A line to write the name on, starting under the label and close below
    // it — the named side opposite gets none.
    const under = (run: { x: number; y: number }) =>
      pdfLines(pdf).filter((l) => l.y1 === l.y2 && l.x1 === run.x && l.y1 - run.y > 8 && l.y1 - run.y < 30);
    expect(under(label).map((l) => l.x2 - l.x1 >= 200)).toEqual([true]);
    expect(under(named)).toEqual([]);
  });

  it("prints the QR only — never the scan URL or its token as text (the token is a bearer secret)", async () => {
    const rows = [row(1), row(2), row(3)];
    const pdf = await renderScorerSheetPdf(model([rows]));
    const printed = pdfTextRuns(pdf).map((r) => r.text).join("\n");
    // The reader sees the lines that ARE printed — so the absence below is not
    // a reader that sees nothing.
    for (const r of rows) expect(printed).toContain(r.home);
    expect(printed).toContain(labels.checkNames);
    for (const r of rows) {
      expect(printed).not.toContain(token(Number(r.fixtureId.slice(1))));
      expect(printed).not.toContain(r.url);
    }
    expect(printed).not.toContain("/score/");
    // Nor anywhere in the uncompressed bytes (document info, annotations)
    // other than each row's own link, which a printout does not show.
    const outsideLinks = pdf.toString("latin1").replace(/\/URI\s*\((?:\\.|[^\\)])*\)/g, "");
    for (const r of rows) expect(outsideLinks).not.toContain(token(Number(r.fixtureId.slice(1))));
  });

  it("every page prints its own court heading and the check-names line", async () => {
    const pdf = await renderScorerSheetPdf({
      ...model([]),
      pages: [
        { heading: "Court 1 · page 1 of 2", rows: [row(1)] },
        { heading: "Court 1 · page 2 of 2", rows: [row(2)] },
        { heading: "Unassigned · page 1 of 1", rows: [row(3)] },
      ],
    });
    const onPage = (n: number) => pdfTextRuns(pdf).filter((r) => r.page === n).map((r) => r.text);
    expect([1, 2, 3].map((n) => onPage(n).filter((t) => t === labels.checkNames).length)).toEqual([1, 1, 1]);
    expect(onPage(1)).toContain("COURT 1 · PAGE 1 OF 2");
    expect(onPage(2)).toContain("COURT 1 · PAGE 2 OF 2");
    expect(onPage(3)).toContain("UNASSIGNED · PAGE 1 OF 1");
  });

  it("five rows stay on one page and clear of the footer — under the masthead and a two-line title", async () => {
    const title = "Northern Counties Inter-Club Badminton Championships — Autumn Series Finals 2026";
    const rows = [1, 2, 3, 4, 5].map((i) => row(i));
    const pdf = await renderScorerSheetPdf({
      header: { ...header, title, branding: { orgName: "Riverside Shuttlers", logos: [] } },
      labels,
      pages: [{ heading: "Court 1 · page 1 of 1", rows }],
    });
    const runs = pdfTextRuns(pdf);
    // Precondition: the masthead is drawn and the title really did wrap.
    expect(runs.map((r) => r.text)).toContain("RIVERSIDE SHUTTLERS");
    expect(runs.filter((r) => r.size === 26).length).toBeGreaterThanOrEqual(2);
    expect(pdfPageCount(pdf)).toBe(1);
    const foot = runs.find((r) => r.text === header.meta.printedAt)!;
    const footTop = foot.y - foot.size;
    const body = runs.filter((r) => r.y !== foot.y);
    expect(body.length).toBeGreaterThan(0);
    expect(Math.max(...body.map((r) => r.y))).toBeLessThan(footTop);
    const qrs = pdfImages(pdf);
    expect(qrs).toHaveLength(5);
    expect(Math.max(...qrs.map((q) => q.top + q.height))).toBeLessThan(footTop);
  });

  it("a long name prints whole — the size gives way (12pt down to 9pt), the name does not", async () => {
    const long = "Maximiliana Alejandra Fernández de Villanueva / Zoë Hartley-Okonkwo-Brightwater";
    const runs = pdfTextRuns(await renderScorerSheetPdf(model([[row(1, { home: long })]])));
    const home = runs.find((r) => r.text.startsWith("Maximiliana"))!;
    expect(home.text).toBe(long);
    expect(home.size).toBeLessThan(12);
    expect(home.size).toBeGreaterThanOrEqual(9);
    expect(runs.find((r) => r.text === "Away 1")!.size).toBe(12);
  });

  it("…but never below 9pt: a name too long even there is cut with an ellipsis", async () => {
    const absurd = Array.from({ length: 6 }, () => "Maximiliana Fernández de Villanueva").join(" / ");
    const runs = pdfTextRuns(await renderScorerSheetPdf(model([[row(1, { home: absurd })]])));
    const home = runs.find((r) => r.text.startsWith("Maximiliana"))!;
    expect(home.size).toBe(9);
    expect(home.text.endsWith("…")).toBe(true);
    expect(absurd.startsWith(home.text.slice(0, -1).trimEnd())).toBe(true);
  });

  it("every line stays ONE line — an overlong heading, match line or roster is cut, never wrapped into the row below", async () => {
    const long = (s: string) => Array.from({ length: 12 }, () => s).join(" ");
    const heading = long("Court Philippe-Chatrier");
    const matchLine = long("Open Mixed Doubles");
    const members = Array.from({ length: 14 }, (_, i) => `Player Number ${i + 1}`);
    const pdf = await renderScorerSheetPdf({
      ...model([]),
      pages: [{ heading, rows: [row(1, { matchLine, homeMembers: members })] }],
    });
    const runs = pdfTextRuns(pdf);
    const cut = (prefix: string) => runs.filter((r) => r.text.startsWith(prefix));
    for (const prefix of ["COURT PHILIPPE", "10:30", "Player Number 1,"]) {
      expect(cut(prefix)).toHaveLength(1);
      expect(cut(prefix)[0]!.text.endsWith("…")).toBe(true);
    }
    // Nothing wrapped: no run starts mid-string.
    expect(runs.filter((r) => /^(Philippe|Chatrier|Open Mixed|Doubles|Player Number \d+,? ?$)/.test(r.text))).toEqual([]);
  });

  it("a team side lists its players under its name; every block carries the paper fallback", async () => {
    const rows = [row(1, { home: "Riverside A", homeMembers: ["Ana Silva", "Ben Cole"] }), row(2)];
    const texts = pdfTextRuns(await renderScorerSheetPdf(model([rows]))).map((r) => r.text);
    expect(texts).toContain("Ana Silva, Ben Cole");
    expect(texts.filter((t) => t.includes(", "))).toHaveLength(1);
    for (const label of [labels.score, labels.winner, labels.signature]) {
      expect(texts.filter((t) => t === label)).toHaveLength(rows.length);
    }
    expect(texts.filter((t) => t === labels.scan)).toHaveLength(rows.length);
  });

  it("refuses a page longer than ROWS_PER_PAGE rather than spill it onto a stray page", async () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => row(i + 1));
    expect(pdfPageCount(await renderScorerSheetPdf(model([rows(ROWS_PER_PAGE)])))).toBe(1);
    await expect(renderScorerSheetPdf(model([rows(ROWS_PER_PAGE + 1)]))).rejects.toThrow(
      `A sheet page holds at most ${ROWS_PER_PAGE} rows; got ${ROWS_PER_PAGE + 1}`,
    );
  });
});

describe("the shared qrBuffer, at the size the sheet prints it", () => {
  it("decodes back to the exact URL (real encoder, real decoder)", async () => {
    const url = `https://example.test/score/${token(7)}`;
    const png = await qrBuffer(url);
    expect(png).not.toBeNull();
    const { data, info } = await sharp(png!).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data).toBe(url);
  });
});
