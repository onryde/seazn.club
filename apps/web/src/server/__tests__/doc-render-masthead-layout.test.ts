// The Pro masthead used to right-align the org name to the SAME edge the org
// logo is drawn against, so every branded PDF with a logo printed
// "RIVERSIDE SHUTT[logo]". The name and the logo are now one right-aligned
// unit: the logo against the right margin, the name ending a fixed 3mm gap
// to its left, and a name too long for the band cut with an ellipsis before it
// reaches the SEAZN wordmark.
//
// Real pdfkit and the real brand fonts, no mocks: every position below is read
// back out of the rendered PDF (e2e/pdf-uris.ts), and glyph widths come from
// pdfkit's own font metrics.
import { beforeAll, describe, expect, it } from "vitest";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import type { DocModel } from "@seazn/engine/exports";
import { FONT, registerFonts } from "../doc-theme";
import { MARGIN, drawMasthead } from "../doc-render";
import { pdfImages, pdfTextRuns, type PdfTextRun } from "../../../e2e/pdf-uris";
import { useBrandFonts } from "./_sheet-fixtures";

beforeAll(useBrandFonts);

const MM = 72 / 25.4;
const GAP = 3 * MM;
const A4_W = 595.28;
const SHORT = "Riverside Shuttlers";
const LONG = "Riverside Shuttlers Badminton Club of Greater Manchester";

// RGBA: pdfkit re-encodes an alpha PNG (plain Flate), which pdfImages reads;
// an RGB PNG is embedded predictor-encoded, which it deliberately refuses.
const png = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 4, background: { r: 15, g: 118, b: 110, alpha: 1 } } }).png().toBuffer();

function measure(font: string, size: number, text: string, characterSpacing = 0): number {
  const m = new PDFDocument({ size: "A4" });
  registerFonts(m);
  return m.font(font).fontSize(size).widthOfString(text, { characterSpacing });
}

async function masthead(orgName: string, logo: Buffer | null) {
  const doc = new PDFDocument({ size: "A4", margin: MARGIN });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));
  registerFonts(doc);
  const model: DocModel = {
    kind: "timetable",
    title: "Autumn Open",
    meta: { printedAt: "2026-09-25" },
    branding: { orgName },
    sections: [],
    pageBreaks: "auto",
  };
  drawMasthead(doc, model, logo);
  doc.end();
  const pdf = await done;
  const runs = pdfTextRuns(pdf);
  // The org name is the masthead's only 10pt run.
  const names = runs.filter((r) => r.size === 10);
  expect(names).toHaveLength(1);
  const name = names[0]!;
  const nameRight = name.x + measure(FONT.bodyMed, 10, name.text, 2);
  const wordmark = runs.filter((r) => r.size === 18);
  const wordmarkRight = Math.max(...wordmark.map((r: PdfTextRun) => r.x + measure(FONT.displayBold, 18, r.text)));
  const images = pdfImages(pdf);
  return { name, nameRight, wordmarkRight, logo: images[0] ?? null, imageCount: images.length };
}

describe("PDF masthead: the org name and the org logo are one right-aligned unit", () => {
  it("a short name ends 3mm left of a square logo, and the logo sits on the right margin", async () => {
    const m = await masthead(SHORT, await png(240, 240));
    expect(m.imageCount).toBe(1);
    expect(m.name.text).toBe(SHORT.toUpperCase());
    expect(m.logo!.x + m.logo!.width).toBeCloseTo(A4_W - MARGIN, 1);
    expect(m.nameRight).toBeLessThanOrEqual(m.logo!.x - GAP + 0.01);
    // …and the gap is the fixed 3mm, not "anywhere left of the logo".
    expect(m.logo!.x - m.nameRight).toBeCloseTo(GAP, 1);
  });

  it("a long name is cut with an ellipsis before it reaches the wordmark, and still clears the logo", async () => {
    const m = await masthead(LONG, await png(240, 240));
    // The whole name would not fit between the wordmark and the logo …
    expect(measure(FONT.bodyMed, 10, LONG.toUpperCase(), 2)).toBeGreaterThan(m.logo!.x - GAP - (m.wordmarkRight + GAP));
    // … so it prints as a prefix of itself ending in an ellipsis.
    expect(m.name.text).toMatch(/…$/);
    expect(LONG.toUpperCase().startsWith(m.name.text.slice(0, -1).trimEnd())).toBe(true);
    expect(m.name.text.length).toBeGreaterThan(10);
    expect(m.name.x).toBeGreaterThanOrEqual(m.wordmarkRight + GAP - 0.01);
    expect(m.nameRight).toBeLessThanOrEqual(m.logo!.x - GAP + 0.01);
  });

  it("with no logo, the name ends on the right margin", async () => {
    const m = await masthead(SHORT, null);
    expect(m.imageCount).toBe(0);
    expect(m.name.text).toBe(SHORT.toUpperCase());
    expect(m.nameRight).toBeCloseTo(A4_W - MARGIN, 1);
  });

  it("with no logo, a long name still stops short of the wordmark", async () => {
    const m = await masthead(`${LONG} and District Junior League`, null);
    expect(m.name.text).toMatch(/…$/);
    expect(m.name.x).toBeGreaterThanOrEqual(m.wordmarkRight + GAP - 0.01);
    expect(m.nameRight).toBeLessThanOrEqual(A4_W - MARGIN + 0.01);
  });

  it("a wide logo is right-aligned by its own width, and capped so the name keeps room", async () => {
    const m = await masthead(SHORT, await png(1000, 100)); // 10:1
    expect(m.logo!.x + m.logo!.width).toBeCloseTo(A4_W - MARGIN, 1);
    expect(m.logo!.width).toBeLessThanOrEqual(120.01);
    expect(m.logo!.height).toBeLessThanOrEqual(40.01);
    expect(m.logo!.x).toBeGreaterThan(m.wordmarkRight + GAP);
    expect(m.nameRight).toBeLessThanOrEqual(m.logo!.x - GAP + 0.01);
  });
});
