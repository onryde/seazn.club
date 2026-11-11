import "server-only";
// server/sponsors/invoice-pdf.ts - a sponsor invoice as a PDF (plan 2026-11-07-sponsor-deals, Task 22; spec §7): the same
// SponsorInvoiceDoc the page draws (./invoice-doc.ts, components/sponsors/invoice-view.tsx), on one A4 sheet in the org's
// language. The sponsor downloads it from the invoice page (`/r/sponsor/invoice/<token>/pdf`), the club from the console
// (`/api/v1/orgs/<id>/sponsor-deals/<dealId>/invoice.pdf`).
//
// The house print identity (doc-theme.ts): Barlow Condensed for the document's own chrome (the title, its number, the section
// heads, the total and the stamp), Inter for everything a person wrote (the club, the sponsor, the address, the bank details) -
// Barlow's narrow caps would turn a sponsor's name into a headline. The one loud element is the state stamp, rotated and
// outlined beside the bill-to block, in the state's colour; the rest stays quiet so the number and the total read first.
//
// No pay button: a PDF cannot post a form, and the token that would open the page never reaches the document. A sponsor
// who wants to pay by card opens the link the club sent.
import PDFDocument from "pdfkit";
import { getDictionary, t } from "@/lib/i18n";
import { INVOICE_STATE_KEY, invoiceDay, invoiceMoney, invoiceNoteKey, type InvoiceState } from "@/lib/sponsor-invoice";
import { TIER_MSG } from "@/components/sponsors/tier-labels";
import { MARGIN, resolveLogo } from "@/server/doc-render";
import { FONT, PALETTE, registerFonts } from "@/server/doc-theme";
import type { SponsorInvoiceDoc } from "./invoice-doc";

/** The stamp's ink, the house print palette and the page's twin (components/sponsors/invoice-view.tsx STAMP_CLASS): unpaid
 *  reads due (the brand's red ball), paid reads settled (night), a refund, a cancellation, a write-off or an ended deal reads
 *  closed (greys). */
const STAMP_INK: Record<InvoiceState, string> = {
  paid: PALETTE.night,
  unpaid: PALETTE.ball,
  refunded: PALETTE.slate,
  void: PALETTE.mute,
  written_off: PALETTE.mute,
  ended: PALETTE.mute,
};

const LOGO_BOX: [number, number] = [132, 44];
const AMOUNT_W = 150;
const LABEL_W = 150;

/** Render a sponsor invoice. Every string in `doc` is already in its locale; the labels come from that locale's dictionary. */
export async function invoicePdf(doc: SponsorInvoiceDoc): Promise<Buffer> {
  const ui = await getDictionary(doc.locale, "ui");
  const logo = await resolveLogo(doc.org.logoPath ?? undefined);
  const title = t(ui, "sponsors.invoice.docTitle", { number: doc.number });

  const pdf = new PDFDocument({
    size: "A4",
    layout: "portrait",
    margins: { top: MARGIN, left: MARGIN, right: MARGIN, bottom: MARGIN },
    bufferPages: true,
    info: { Title: title, Author: doc.org.name },
  });
  const chunks: Buffer[] = [];
  pdf.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => pdf.on("end", () => resolve(Buffer.concat(chunks))));
  registerFonts(pdf);

  const width = pdf.page.width - MARGIN * 2;
  const right = MARGIN + width;
  const money = (cents: number) => invoiceMoney(doc.locale, cents, doc.line.currency);

  // -- The club (left) and the document (right). ---------------------------------------------------------------------------
  const leftW = width * 0.56;
  let leftY = MARGIN;
  if (logo) {
    try {
      pdf.image(logo, MARGIN, leftY, { fit: LOGO_BOX });
      leftY += LOGO_BOX[1] + 10;
    } catch {
      // A logo pdfkit cannot read prints an unbranded invoice, never a failed one (doc-render's rule).
    }
  }
  pdf.font(FONT.bodyMed).fontSize(13).fillColor(PALETTE.ink).text(doc.org.name, MARGIN, leftY, { width: leftW });
  leftY = pdf.y + 2;
  if (doc.org.address) {
    pdf.font(FONT.body).fontSize(9).fillColor(PALETTE.slate).text(doc.org.address, MARGIN, leftY, { width: leftW, lineGap: 1.5 });
    leftY = pdf.y;
  }

  const rightX = MARGIN + width * 0.6;
  const rightW = width * 0.4;
  pdf.font(FONT.displayBold).fontSize(30).fillColor(PALETTE.night)
    .text(t(ui, "sponsors.invoice.title"), rightX, MARGIN - 4, { width: rightW, align: "right" });
  pdf.font(FONT.display).fontSize(17).fillColor(PALETTE.ink).text(doc.number, rightX, pdf.y - 2, { width: rightW, align: "right" });
  pdf.font(FONT.body).fontSize(8).fillColor(PALETTE.mute)
    .text(t(ui, "sponsors.invoice.date"), rightX, pdf.y + 6, { width: rightW, align: "right" });
  pdf.font(FONT.bodyMed).fontSize(10).fillColor(PALETTE.ink)
    .text(invoiceDay(doc.locale, doc.issuedOn), rightX, pdf.y + 1, { width: rightW, align: "right" });
  const rightY = pdf.y;

  // The brand rule: lime, with the red ball resting on its right end (doc-render's masthead mark).
  const ruleY = Math.max(leftY, rightY) + 16;
  pdf.rect(MARGIN, ruleY, width, 3).fill(PALETTE.lime);
  pdf.circle(right - 6, ruleY - 3.5, 3.5).fill(PALETTE.ball);

  // -- Billed to, and the stamp beside it. ----------------------------------------------------------------------------------
  let y = ruleY + 24;
  const billedW = width * 0.6;
  section(pdf, t(ui, "sponsors.invoice.billedTo"), MARGIN, y);
  pdf.font(FONT.bodyMed).fontSize(12).fillColor(PALETTE.ink).text(doc.billedTo.name, MARGIN, pdf.y + 3, { width: billedW });
  if (doc.billedTo.email) {
    pdf.font(FONT.body).fontSize(9).fillColor(PALETTE.slate).text(doc.billedTo.email, MARGIN, pdf.y + 1, { width: billedW });
  }
  const billedBottom = pdf.y;
  drawStamp(pdf, t(ui, INVOICE_STATE_KEY[doc.state]), STAMP_INK[doc.state], right, y + 4);
  y = Math.max(billedBottom, y + 52) + 26;

  // -- The line and its total. -----------------------------------------------------------------------------------------------
  const descW = width - AMOUNT_W - 12;
  pdf.font(FONT.display).fontSize(10).fillColor(PALETTE.mute)
    .text(t(ui, "sponsors.invoice.description"), MARGIN, y, { width: descW, lineBreak: false });
  pdf.font(FONT.display).fontSize(10).fillColor(PALETTE.mute)
    .text(t(ui, "sponsors.invoice.amount"), right - AMOUNT_W, y, { width: AMOUNT_W, align: "right", lineBreak: false });
  y += 16;
  hairline(pdf, y, width);
  y += 10;
  pdf.font(FONT.bodyMed).fontSize(11).fillColor(PALETTE.ink).text(doc.line.description, MARGIN, y, { width: descW });
  const descBottom = pdf.y;
  pdf.font(FONT.body).fontSize(11).fillColor(PALETTE.ink)
    .text(money(doc.line.amountCents), right - AMOUNT_W, y, { width: AMOUNT_W, align: "right" });
  y = Math.max(descBottom, pdf.y) + 10;
  hairline(pdf, y, width);
  y += 12;
  pdf.font(FONT.displayBold).fontSize(13).fillColor(PALETTE.ink)
    .text(t(ui, "sponsors.invoice.total"), MARGIN, y + 5, { width: descW, lineBreak: false });
  // The total in Inter, not Barlow: Barlow has no narrow no-break space (U+202F), which fr groups thousands with.
  pdf.font(FONT.bodyMed).fontSize(20).fillColor(PALETTE.night)
    .text(money(doc.line.amountCents), right - AMOUNT_W - 60, y, { width: AMOUNT_W + 60, align: "right" });
  y = pdf.y + 4;
  const note = invoiceNoteKey(doc.state, doc.dealEnded);
  if (note !== null) {
    pdf.font(FONT.body).fontSize(9).fillColor(PALETTE.slate)
      .text(t(ui, note, { club: doc.org.name }), MARGIN, y, { width });
    y = pdf.y;
  }

  // -- What's included. -----------------------------------------------------------------------------------------------------
  y += 26;
  section(pdf, t(ui, "sponsors.invoice.included.title"), MARGIN, y, 13);
  y = pdf.y + 8;
  const rows: [string, string][] = [
    [t(ui, "sponsors.invoice.included.tier"), t(ui, TIER_MSG[doc.included.tier])],
    [t(ui, "sponsors.invoice.included.scope"), doc.included.scope],
    [t(ui, "sponsors.invoice.included.where"), t(ui, "sponsors.invoice.included.whereValue")],
    [t(ui, "sponsors.invoice.included.onStream"), t(ui, doc.included.onStream ? "sponsors.invoice.included.yes" : "sponsors.invoice.included.no")],
  ];
  for (const [label, value] of rows) {
    pdf.font(FONT.body).fontSize(9).fillColor(PALETTE.mute).text(label, MARGIN, y + 1, { width: LABEL_W });
    const labelBottom = pdf.y;
    pdf.font(FONT.bodyMed).fontSize(10).fillColor(PALETTE.ink).text(value, MARGIN + LABEL_W + 10, y, { width: width - LABEL_W - 10 });
    y = Math.max(labelBottom, pdf.y) + 6;
  }

  // -- How to pay by transfer, while it is due. -------------------------------------------------------------------------------
  if (doc.bankDetails) {
    y += 20;
    section(pdf, t(ui, "sponsors.invoice.bankDetails"), MARGIN, y, 13);
    pdf.font(FONT.body).fontSize(10).fillColor(PALETTE.ink).text(doc.bankDetails, MARGIN, pdf.y + 6, { width: width * 0.7, lineGap: 2 });
    pdf.font(FONT.body).fontSize(9).fillColor(PALETTE.slate)
      .text(t(ui, "sponsors.invoice.bankReference", { number: doc.number }), MARGIN, pdf.y + 6, { width });
  }

  // Footer on every page (a long address or bank block can run onto a second sheet).
  const range = pdf.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    pdf.switchToPage(i);
    const footerY = pdf.page.height - MARGIN - 9;
    pdf.font(FONT.body).fontSize(7).fillColor(PALETTE.mute).text(title, MARGIN, footerY, { width: 260, lineBreak: false });
    pdf.font(FONT.body).fontSize(7).fillColor(PALETTE.mute)
      .text("seazn.club", right - 200, footerY, { width: 200, align: "right", lineBreak: false });
  }
  pdf.end();
  return done;
}

/** A section head: Barlow, sentence case, muted - a label, not a shout. */
function section(pdf: PDFKit.PDFDocument, text: string, x: number, y: number, size = 10): void {
  pdf.font(FONT.display).fontSize(size).fillColor(size > 10 ? PALETTE.ink : PALETTE.mute).text(text, x, y);
}

function hairline(pdf: PDFKit.PDFDocument, y: number, width: number): void {
  pdf.moveTo(MARGIN, y).lineTo(MARGIN + width, y).lineWidth(0.75).strokeColor(PALETTE.hairline).stroke();
}

/** The state stamp: the label in Barlow Bold inside an outlined box, tilted like a rubber stamp, its right edge at `right`.
 *  Measured, so a long label ("Remboursée", "Terugbetaald") never runs out of its box. */
function drawStamp(pdf: PDFKit.PDFDocument, label: string, ink: string, right: number, top: number): void {
  pdf.font(FONT.displayBold).fontSize(22);
  const textW = pdf.widthOfString(label) + label.length * 1.5;
  const boxW = textW + 28;
  const boxH = 38;
  const x = right - boxW - 8;
  pdf.save();
  pdf.rotate(-7, { origin: [x + boxW / 2, top + boxH / 2] });
  pdf.roundedRect(x, top, boxW, boxH, 4).lineWidth(2).strokeColor(ink).stroke();
  pdf.fillColor(ink).text(label, x + 14, top + 8, { characterSpacing: 1.5, lineBreak: false });
  pdf.restore();
  pdf.fillColor(PALETTE.ink);
}
