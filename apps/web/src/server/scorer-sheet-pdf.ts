import "server-only";
// Scorer sheets §4.4 — A4 portrait, on the shared document system:
// doc-theme's fonts and palette, and doc-render's masthead (Pro
// `exports.branded` only). Owner-approved layout (2026-09-24): full width,
// 8 mm edges, a 3×3 grid of cut-out cards per page, in time order
// left→right then top→bottom, one court per page run. Each page's header
// carries the court heading ("COURT 2 · PAGE 1 OF 2") and the check-names line
// BESIDE the title, so the cards get the height. A card: time, the board's
// match code, the division, both sides, and a branded QR — no score, winner
// or umpire lines (scoring happens on the phone the QR opens).
//
// The QR (owner pick "B2", decode evidence in the spec): error correction H,
// square navy data modules, SOLID rounded navy finders (outer radius 2.0
// modules, the centre of the band that decoded everywhere — jsQR, the CI
// decoder, never finds dotted finders), and the Seazn app icon, 12 mm, over a knocked-out
// centre with at least one module of white round it. Each symbol is ALSO a
// link annotation, so a phone that opens the PDF can tap it. The scan URL is
// never printed as text: its token is a bearer secret, and a photo of a
// sheet must not leak it (controller ruling 2026-09-24).
//
// Glyphs, measured with fontkit against assets/fonts on 2026-09-23:
// Inter (FONT.body/bodyMed) covers Latin-1, Latin Extended-A, Vietnamese,
// Greek and Cyrillic. It has none of Tamil, Devanagari, Arabic, Hebrew, Thai
// or CJK. Barlow Condensed (FONT.display*) covers Latin and Vietnamese only:
// 4/57 Greek, 0/64 Cyrillic. So every PERSON name is set in Inter, never in
// Barlow. Barlow is used only for our own chrome (title, court heading, match
// code), where the four UI locales are all Latin.
import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import type { DocModel } from "@seazn/engine/exports";
import { ROWS_PER_PAGE, type SheetHeading } from "@/lib/scorer-sheets";
import { FONT, PALETTE, registerFonts } from "./doc-theme";
import { MARGIN, drawMasthead, resolveLogo } from "./doc-render";
import { log } from "./logger";

export interface SheetRow {
  fixtureId: string;
  url: string;
  time: string;
  /** The board's code for the match ("QF·2"), as the schedule shows it. */
  matchRef: string;
  division: string;
  home: string;
  away: string;
  /** A side not yet known prints its slot label ("Winner of QF·2") over a pen line. */
  homeTbd: boolean;
  awayTbd: boolean;
  /** A doubles pair's two members, one per line; empty for anyone else. */
  homePair: string[];
  awayPair: string[];
}

export interface SheetModel {
  /** Masthead + title block only — `sections` stays empty. */
  header: DocModel;
  /** `heading` in parts (`courtPageHeading`): a long court name is shortened,
   *  the page count never is. */
  pages: { heading: SheetHeading; rows: SheetRow[] }[];
  /** No page counter here: numbering is per court and lives in each page's
   *  heading (owner ruling Q7). `checkNames` is the spec §4.4 page-header line. */
  labels: { eyebrow: string; checkNames: string };
}

const MM = 72 / 25.4;
/** Paper edge to cut line, all round. */
const EDGE = 8 * MM;
const COLS = 3;
const ROWS = 3;
/** Text inset from a card's side cut lines. */
const PAD = 10;
/** Person names, and the line box Inter gives them at that size. */
const NAME = 9;
const LH = NAME * 1.21;
/** White, in modules, from the symbol to the text above and to the cut lines. */
const QUIET = 4.1;
/** Finder corner radii, in modules: the 7×7 ring, and the 3×3 centre. */
const FINDER_R = 2;
const FINDER_CENTRE_R = 0.6;
/** The centre icon's side, and the white round it, in modules. */
const ICON = 12 * MM;
const ICON_PAD = 1;
/** The gap between the title and the court heading beside it. */
const GAP = 16;

/** One line at `size`, cut with an ellipsis. `lineBreak: false` alone does
 *  not do it: pdfkit still WRAPS a string wider than `width` onto the lines
 *  below (the bracket poster's F6 note in doc-render.ts), and it only applies
 *  the ellipsis when a `height` bound leaves no room for a second line. */
function oneLine(width: number, size: number): PDFKit.Mixins.TextOptions {
  return { width, height: size * 1.5, lineBreak: false, ellipsis: true };
}

/** The court heading, upper-cased, on one line at most `max` wide in the
 *  current font. Only the court's NAME gives way (ending in "…"): cutting the
 *  whole line took "PAGE 1 OF 2" off a long venue name's sheet (Task 10's
 *  journey printed "COURT 1 (E2E VENUE …) · PA…"). */
function fitHeading(doc: PDFKit.PDFDocument, heading: SheetHeading, max: number): string {
  const [before, court, after] = [heading.before, heading.court, heading.after].map((s) => s.toUpperCase());
  const whole = `${before}${court}${after}`;
  if (doc.widthOfString(whole) <= max) return whole;
  const room = max - doc.widthOfString(`${before}…${after}`);
  const kept = [...court];
  while (kept.length > 0 && doc.widthOfString(kept.join("")) > room) kept.pop();
  return `${before}${kept.join("").trimEnd()}…${after}`;
}

/** The Seazn app icon (public/logo-square.png; no vector exists). Everything
 *  that serves a request runs from apps/web: the image's standalone server.js
 *  chdirs to its own directory (/app/apps/web, where the Dockerfile copies
 *  public/), and next dev and vitest start there — so production is found by
 *  the SECOND candidate, `public`. The first serves a script run from the repo
 *  root. Missing, the sheet prints plain QR codes — they decode the same —
 *  rather than fail. */
function brandIcon(): Buffer | null {
  for (const dir of ["apps/web/public", "public"]) {
    const file = path.join(process.cwd(), dir, "logo-square.png");
    if (fs.existsSync(file)) return fs.readFileSync(file);
  }
  log.warn({ cwd: process.cwd() }, "scorer sheets: logo-square.png not found; printing QR codes without the centre icon");
  return null;
}

type Image = { width: number; height: number };
type Doc = PDFKit.PDFDocument & { openImage(src: Buffer): Image };
/** pdfkit embeds an opened image once and reuses it on every draw; its types
 *  only admit a Buffer, which would embed a copy per card. */
const drawImage = (doc: PDFKit.PDFDocument, img: Image, x: number, y: number, side: number) =>
  doc.image(img as unknown as Buffer, x, y, { width: side, height: side });

export async function renderScorerSheetPdf(model: SheetModel): Promise<Buffer> {
  // Encode every symbol first, as docModelToPdf pre-passes its QR codes: a
  // card without a code is a card nobody can scan, so fail the whole print.
  const qrs = new Map<string, QRCode.QRCode>();
  for (const page of model.pages) {
    if (page.rows.length > ROWS_PER_PAGE) {
      throw new Error(`A sheet page holds at most ${ROWS_PER_PAGE} rows; got ${page.rows.length}`);
    }
    for (const r of page.rows) {
      try {
        qrs.set(r.fixtureId, QRCode.create(r.url, { errorCorrectionLevel: "H" }));
      } catch (cause) {
        throw new Error(`QR generation failed for fixture ${r.fixtureId}`, { cause });
      }
    }
  }
  const logo = model.header.branding ? await resolveLogo(model.header.branding.logos?.[0]) : null;
  const iconBytes = brandIcon();

  const doc = new PDFDocument({
    size: "A4",
    layout: "portrait",
    margins: { top: EDGE, left: EDGE, right: EDGE, bottom: EDGE },
    bufferPages: true,
    info: { Title: model.header.title },
  }) as Doc;
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));
  registerFonts(doc);
  const icon = iconBytes ? doc.openImage(iconBytes) : null;

  const pageW = doc.page.width;
  // The 7pt footer sits inside the bottom edge band; the cards end above it.
  const footerY = doc.page.height - EDGE - 9.5;
  const cardsBottom = footerY - 3;
  const cardW = (pageW - EDGE * 2) / COLS;

  for (const [p, page] of model.pages.entries()) {
    if (p > 0) doc.addPage();
    if (model.header.branding) {
      drawMasthead(doc, model.header, logo);
      doc.y -= 8; // the masthead leaves 18pt under its rule; 10 is enough on a cut sheet
    } else doc.y = EDGE;
    const top = drawHeader(doc, model, page.heading);
    const cardH = (cardsBottom - top) / ROWS;
    const cells = page.rows.map((r, i) => ({
      r,
      col: i % COLS,
      row: Math.floor(i / COLS),
      x: EDGE + (i % COLS) * cardW,
      y: top + Math.floor(i / COLS) * cardH,
    }));
    drawCutLines(doc, cells, top, cardW, cardH, pageW);
    for (const c of cells) drawCard(doc, c.r, qrs.get(c.r.fixtureId)!, icon, c.x, c.y, cardW, cardH);
  }

  // Own footer: doc-render's says "printed … page N of M" in English, and it
  // numbers the whole PDF. The sheet numbers per court in each heading (Q7).
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.font(FONT.body).fontSize(7).fillColor(PALETTE.mute)
      .text(model.header.meta.printedAt, EDGE, footerY, { width: 200, lineBreak: false });
    doc.font(FONT.body).fontSize(7).fillColor(PALETTE.mute)
      .text("seazn.club", pageW - EDGE - 200, footerY, { width: 200, align: "right", lineBreak: false });
  }
  doc.end();
  return done;
}

/** Eyebrow, title and description on the left — doc-render's title block,
 *  held to two title lines and one description line so the header's height
 *  (and so the QR size) is bounded — with the court heading on the title's
 *  baseline and the check-names line on the description's, right-aligned to
 *  the masthead's edge. Returns where the cards start. */
function drawHeader(doc: PDFKit.PDFDocument, model: SheetModel, heading: SheetHeading): number {
  const left = MARGIN;
  const right = doc.page.width - MARGIN;
  const width = right - left;
  doc.font(FONT.displayBold).fontSize(16);
  const head = fitHeading(doc, heading, width / 2);
  const headW = doc.widthOfString(head);
  const barlowAscent = (doc as unknown as { _font: { ascender: number } })._font.ascender / 1000;
  doc.font(FONT.bodyMed).fontSize(9);
  const checkW = Math.min(doc.widthOfString(model.labels.checkNames), width * 0.7);
  const line9 = doc.currentLineHeight(true);

  doc.font(FONT.bodyMed).fontSize(8).fillColor(PALETTE.mute)
    .text(model.labels.eyebrow, left, doc.y, { ...oneLine(width, 8), characterSpacing: 2 });
  doc.moveDown(0.1);
  const titleTop = doc.y;
  doc.font(FONT.displayBold).fontSize(26).fillColor(PALETTE.night);
  doc.text(model.header.title.toUpperCase(), left, titleTop, {
    width: width - headW - GAP,
    height: doc.currentLineHeight(true) * 2.5,
    ellipsis: true,
    characterSpacing: 0.5,
  });
  doc.moveDown(0.15);
  const descTop = doc.y;
  if (model.header.description) {
    doc.font(FONT.body).fontSize(9).fillColor(PALETTE.slate)
      .text(model.header.description, left, descTop, oneLine(width - checkW - GAP, 9));
  }
  // Same baseline as the title's first line: the heading is smaller, so it
  // starts lower by the difference in ascent.
  doc.font(FONT.displayBold).fontSize(16).fillColor(PALETTE.night)
    .text(head, right - headW - 1, titleTop + barlowAscent * (26 - 16), { ...oneLine(headW + 2, 16), align: "right" });
  doc.font(FONT.bodyMed).fontSize(9).fillColor(PALETTE.slate)
    .text(model.labels.checkNames, right - checkW - 1, descTop, { ...oneLine(checkW + 2, 9), align: "right" });
  return descTop + line9 + 5;
}

/** Dashed cut lines, each drawn ONCE as one continuous run (a shared edge
 *  drawn twice dashes out of phase): horizontals the full page width at every
 *  occupied row's top and bottom; verticals down each column boundary for as
 *  many rows as touch it. */
function drawCutLines(
  doc: PDFKit.PDFDocument,
  cells: { col: number; row: number }[],
  top: number,
  cardW: number,
  cardH: number,
  pageW: number,
): void {
  const rowsUsed = Math.ceil(cells.length / COLS);
  doc.save().dash(3, { space: 3 }).strokeColor("#9ca3af").lineWidth(0.5);
  for (let r = 0; r <= rowsUsed; r++) doc.moveTo(0, top + r * cardH).lineTo(pageW, top + r * cardH).stroke();
  for (let k = 0; k <= COLS; k++) {
    const rowsTouching = new Set(cells.filter((c) => c.col === k || c.col === k - 1).map((c) => c.row)).size;
    if (rowsTouching > 0) doc.moveTo(EDGE + k * cardW, top).lineTo(EDGE + k * cardW, top + rowsTouching * cardH).stroke();
  }
  doc.undash().restore();
}

function drawCard(
  doc: PDFKit.PDFDocument,
  r: SheetRow,
  qr: QRCode.QRCode,
  icon: Image | null,
  x: number,
  y: number,
  cardW: number,
  cardH: number,
): void {
  const iw = cardW - PAD * 2;
  const ix = x + PAD;
  // Time left, the board's match code right, the division under them.
  doc.font(FONT.bodyMed).fontSize(11).fillColor(PALETTE.ink).text(r.time, ix, y + 8, oneLine(iw / 2, 11));
  doc.font(FONT.displayBold).fontSize(13).fillColor(PALETTE.night)
    .text(r.matchRef, ix + iw / 2, y + 7, { ...oneLine(iw / 2, 13), align: "right" });
  doc.font(FONT.body).fontSize(8).fillColor(PALETTE.slate).text(r.division, ix, y + 23, oneLine(iw, 8));
  // Two lines per side, a short hairline between the sides.
  const ny = y + 36;
  drawSide(doc, r.home, r.homeTbd, r.homePair, ix, ny, iw);
  doc.moveTo(ix, ny + 2 * LH + 3).lineTo(ix + 24, ny + 2 * LH + 3).strokeColor(PALETTE.hairline).lineWidth(0.75).stroke();
  drawSide(doc, r.away, r.awayTbd, r.awayPair, ix, ny + 2 * LH + 7, iw);
  const namesBottom = ny + 4 * LH + 7;
  // The QR: the largest symbol that keeps QUIET modules of white to the text
  // above, to the cut line below and to both side cuts.
  const n = qr.modules.size;
  const size = Math.min(((y + cardH - namesBottom) * n) / (n + 2 * QUIET), (cardW * n) / (n + 2 * QUIET));
  const mod = size / n;
  const qx = x + (cardW - size) / 2;
  const qy = y + cardH - QUIET * mod - size;
  drawBrandQr(doc, qr, qx, qy, mod, icon);
  doc.link(qx, qy, size, size, r.url);
}

/** Square navy data modules (one path, one fill — no seams between them),
 *  solid rounded navy finders, and the icon over a knocked-out centre. */
function drawBrandQr(doc: PDFKit.PDFDocument, qr: QRCode.QRCode, x: number, y: number, mod: number, icon: Image | null): void {
  const n = qr.modules.size;
  const dark = (r: number, c: number) => qr.modules.get(r, c) === 1;
  const finders: [number, number][] = [[0, 0], [0, n - 7], [n - 7, 0]];
  const inFinder = (r: number, c: number) => finders.some(([r0, c0]) => r >= r0 && r < r0 + 7 && c >= c0 && c < c0 + 7);
  // The knock-out: the smallest ODD square of modules, centred on the grid
  // (n is odd), that holds the icon and its white pad.
  let k = 0;
  if (icon) {
    k = Math.ceil(ICON / mod + 2 * ICON_PAD);
    if (k % 2 === 0) k += 1;
  }
  const k0 = (n - k) / 2;
  const inKnockout = (r: number, c: number) => r >= k0 && r < k0 + k && c >= k0 && c < k0 + k;
  const drawn = (r: number, c: number) => dark(r, c) && !inFinder(r, c) && !inKnockout(r, c);
  doc.save();
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!drawn(r, c)) continue;
      const start = c;
      while (c < n && drawn(r, c)) c++;
      doc.rect(x + start * mod, y + r * mod, (c - start) * mod, mod);
    }
  }
  doc.fill(PALETTE.night);
  // Finders: the 7×7 ring is the outer rounded square minus the 5×5 inner one
  // (even-odd), and the 3×3 centre sits in that hole, so even-odd fills it
  // again. The straight edges are whole modules, so every centre line reads
  // 1:1:3:1:1.
  for (const [r0, c0] of finders) {
    const fx = x + c0 * mod;
    const fy = y + r0 * mod;
    doc.roundedRect(fx, fy, 7 * mod, 7 * mod, FINDER_R * mod);
    doc.roundedRect(fx + mod, fy + mod, 5 * mod, 5 * mod, (FINDER_R - 1) * mod);
    doc.roundedRect(fx + 2 * mod, fy + 2 * mod, 3 * mod, 3 * mod, FINDER_CENTRE_R * mod);
  }
  doc.fill(PALETTE.night, "even-odd");
  doc.restore();
  if (icon) {
    const centre = (n * mod) / 2;
    drawImage(doc, icon, x + centre - ICON / 2, y + centre - ICON / 2, ICON);
  }
}

function drawSide(doc: PDFKit.PDFDocument, name: string, tbd: boolean, pair: string[], x: number, y: number, w: number): void {
  if (tbd) {
    doc.font(FONT.bodyMed).fontSize(NAME).fillColor(PALETTE.slate).text(name, x, y, oneLine(w, NAME));
    doc.moveTo(x, y + 2 * LH - 1).lineTo(x + w, y + 2 * LH - 1).strokeColor(PALETTE.slate).lineWidth(0.6).stroke();
    return;
  }
  doc.font(FONT.bodyMed).fontSize(NAME).fillColor(PALETTE.ink);
  if (pair.length >= 2) {
    pair.slice(0, 2).forEach((member, i) => doc.text(member, x, y + i * LH, oneLine(w, NAME)));
  } else {
    // One name wraps onto a second line, then takes an ellipsis: the height
    // bound, in [2, 3) lines, is what stops a third.
    doc.text(name, x, y, { width: w, height: LH * 2.5, ellipsis: true });
  }
}
