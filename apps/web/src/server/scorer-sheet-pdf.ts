import "server-only";
// Scorer sheets §4.4 — A4 portrait, on the shared document system:
// doc-theme's fonts, palette and QR helper, and doc-render's masthead (Pro
// `exports.branded` only) and title block. Its own body, because a match
// block is not a DocModel section (the engine type is out of scope, and the
// ticket section's QR has no link and its footer is English). Per page: the
// court heading, the check-names line, then up to ROWS_PER_PAGE match blocks.
// Each QR image is ALSO a link annotation, so a phone that opens the PDF can
// tap it. The scan URL is never printed as text: its token is a bearer
// secret, and a photo of a sheet must not leak it (controller ruling
// 2026-09-24) — the QR is its only printed form. A TBD side prints its slot
// label over a pen line.
//
// Glyphs, measured with fontkit against assets/fonts on 2026-09-23:
// Inter (FONT.body/bodyMed) covers Latin-1, Latin Extended-A, Vietnamese,
// Greek and Cyrillic. It has none of Tamil, Devanagari, Arabic, Hebrew, Thai
// or CJK. Barlow Condensed (FONT.display*) covers Latin and Vietnamese only:
// 4/57 Greek, 0/64 Cyrillic. So every PERSON name is set in Inter, never in
// Barlow. Barlow is used only for our own chrome (court heading), where the
// four UI locales are all Latin.
import PDFDocument from "pdfkit";
import type { DocModel } from "@seazn/engine/exports";
import { ROWS_PER_PAGE } from "@/lib/scorer-sheets";
import { FONT, PALETTE, qrBuffer, registerFonts } from "./doc-theme";
import { MARGIN, drawMasthead, drawTitleBlock, resolveLogo } from "./doc-render";

export interface SheetRow {
  fixtureId: string;
  url: string;
  time: string;
  matchLine: string;
  home: string;
  away: string;
  homeTbd: boolean;
  awayTbd: boolean;
  homeMembers: string[];
  awayMembers: string[];
}

export interface SheetModel {
  /** Masthead + title block only — `sections` stays empty. */
  header: DocModel;
  pages: { heading: string; rows: SheetRow[] }[];
  /** No page counter here: numbering is per court and lives in each page's
   *  heading (owner ruling Q7). `checkNames` is the spec §4.4 page-header line. */
  labels: { eyebrow: string; scan: string; winner: string; score: string; signature: string; checkNames: string };
}

// One match block at full size, in points. Every vertical offset below is on
// this scale; a tall header (the Pro masthead plus a title that wraps) shrinks
// the whole block, QR included, by one factor so ROWS_PER_PAGE blocks always
// end above the footer. Overflowing is not an option: pdfkit silently moves a
// line drawn past the bottom margin onto a new page of its own.
const BLOCK = 120;
const QR = 96;
const GUTTER = 18;
/** The footer's line (doc-render's position: text at or below
 *  page.height - MARGIN is suppressed by pdfkit). */
const footerY = (doc: PDFKit.PDFDocument) => doc.page.height - MARGIN - 10;

/** One line at `size`, cut with an ellipsis. `lineBreak: false` alone does
 *  not do it: pdfkit still WRAPS a string wider than `width` onto the lines
 *  below (the bracket poster's F6 note in doc-render.ts), and it only applies
 *  the ellipsis when a `height` bound leaves no room for a second line. */
function oneLine(width: number, size: number): PDFKit.Mixins.TextOptions {
  return { width, height: size * 1.5, lineBreak: false, ellipsis: true };
}

export async function renderScorerSheetPdf(model: SheetModel): Promise<Buffer> {
  // QR pre-pass, as docModelToPdf does it: pdfkit draws synchronously. A null
  // QR is a sheet nobody can scan, so fail the print rather than ship it.
  const qrs = new Map<string, Buffer>();
  for (const page of model.pages) {
    if (page.rows.length > ROWS_PER_PAGE) {
      throw new Error(`A sheet page holds at most ${ROWS_PER_PAGE} rows; got ${page.rows.length}`);
    }
    for (const r of page.rows) {
      const png = await qrBuffer(r.url);
      if (!png) throw new Error(`QR generation failed for fixture ${r.fixtureId}`);
      qrs.set(r.fixtureId, png);
    }
  }
  const logo = model.header.branding ? await resolveLogo(model.header.branding.logos?.[0]) : null;

  const doc = new PDFDocument({ size: "A4", layout: "portrait", margin: MARGIN, bufferPages: true, info: { Title: model.header.title } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));
  registerFonts(doc);
  const width = doc.page.width - MARGIN * 2;

  for (const [p, page] of model.pages.entries()) {
    if (p > 0) doc.addPage();
    if (model.header.branding) drawMasthead(doc, model.header, logo);
    else doc.y = MARGIN;
    drawTitleBlock(doc, model.header, model.labels.eyebrow);
    doc.font(FONT.displayBold).fontSize(16).fillColor(PALETTE.night)
      .text(page.heading.toUpperCase(), MARGIN, doc.y, oneLine(width, 16));
    doc.font(FONT.bodyMed).fontSize(9).fillColor(PALETTE.slate)
      .text(model.labels.checkNames, MARGIN, doc.y + 2, oneLine(width, 9));
    const top = doc.y + 8;
    const k = Math.min(1, (footerY(doc) - 6 - top) / (ROWS_PER_PAGE * BLOCK));
    for (const [i, r] of page.rows.entries()) {
      drawBlock(doc, model.labels, r, qrs.get(r.fixtureId)!, top + i * BLOCK * k, width, k);
    }
    if (page.rows.length > 0) {
      const end = top + page.rows.length * BLOCK * k;
      doc.moveTo(MARGIN, end).lineTo(MARGIN + width, end).strokeColor(PALETTE.hairline).lineWidth(0.75).stroke();
    }
  }

  // Own footer: doc-render's says "printed … page N of M" in English, and it
  // numbers the whole PDF. The sheet numbers per court in each heading (Q7).
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const fy = footerY(doc);
    doc.font(FONT.body).fontSize(7).fillColor(PALETTE.mute)
      .text(model.header.meta.printedAt, MARGIN, fy, { width: width - 90, lineBreak: false });
    doc.font(FONT.body).fontSize(7).fillColor(PALETTE.mute)
      .text("seazn.club", MARGIN, fy, { width, align: "right", lineBreak: false });
  }
  doc.end();
  return done;
}

function drawBlock(
  doc: PDFKit.PDFDocument,
  labels: SheetModel["labels"],
  r: SheetRow,
  qr: Buffer,
  y: number,
  width: number,
  k: number,
): void {
  const at = (dy: number) => y + dy * k;
  const q = QR * k;
  doc.moveTo(MARGIN, y).lineTo(MARGIN + width, y).strokeColor(PALETTE.hairline).lineWidth(0.75).stroke();
  doc.image(qr, MARGIN, at(10), { width: q, height: q, link: r.url });
  doc.font(FONT.bodyMed).fontSize(7).fillColor(PALETTE.mute)
    .text(labels.scan, MARGIN, at(10) + q + 2, { ...oneLine(q, 7), align: "center" });

  const x = MARGIN + q + GUTTER;
  const w = width - q - GUTTER;
  doc.font(FONT.bodyMed).fontSize(10).fillColor(PALETTE.slate)
    .text(`${r.time}  ·  ${r.matchLine}`, x, at(10), oneLine(w, 10));
  side(doc, r.home, r.homeTbd, r.homeMembers, x, at(27), w, k);
  side(doc, r.away, r.awayTbd, r.awayMembers, x, at(60), w, k);

  // The paper fallback: score, winner and the umpire's name, on pen lines
  // sized for what gets written there (a three-game score is the longest).
  let fx = x;
  for (const [label, share] of [[labels.score, 0.45], [labels.winner, 0.3], [labels.signature, 0.25]] as const) {
    const fw = w * share;
    doc.font(FONT.body).fontSize(8).fillColor(PALETTE.slate).text(label, fx, at(97), { lineBreak: false });
    const lx = fx + doc.widthOfString(label) + 4;
    doc.moveTo(lx, at(106)).lineTo(fx + fw - 10, at(106)).strokeColor(PALETTE.slate).lineWidth(0.6).stroke();
    fx += fw;
  }
}

/** Largest size from `max` down to `min` at which `text` fits `width` in
 *  `font`; below `min` the caller's ellipsis takes over. */
function fitSize(doc: PDFKit.PDFDocument, text: string, font: string, max: number, min: number, width: number): number {
  const natural = doc.font(font).fontSize(max).widthOfString(text);
  return natural <= width ? max : Math.max(min, Math.floor((max * width) / natural * 10) / 10);
}

function side(doc: PDFKit.PDFDocument, name: string, tbd: boolean, members: string[], x: number, y: number, w: number, k: number) {
  // Person names in Inter (FONT.bodyMed) — Barlow has no Cyrillic/Greek.
  if (tbd) {
    doc.font(FONT.bodyMed).fontSize(10).fillColor(PALETTE.slate)
      .text(name, x, y, oneLine(w, 10));
    doc.moveTo(x, y + 27 * k).lineTo(x + Math.min(w, 240), y + 27 * k).strokeColor(PALETTE.slate).lineWidth(0.6).stroke();
    return;
  }
  const size = fitSize(doc, name, FONT.bodyMed, 12, 9, w);
  doc.font(FONT.bodyMed).fontSize(size).fillColor(PALETTE.ink)
    .text(name, x, y + (12 - size) * 0.8, oneLine(w, size));
  if (members.length > 0) {
    doc.font(FONT.body).fontSize(8).fillColor(PALETTE.slate)
      .text(members.join(", "), x, y + 16 * k, oneLine(w, 8));
  }
}
