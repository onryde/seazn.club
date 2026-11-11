// Sponsor invoices (plan 2026-11-07-sponsor-deals, Task 22; spec §7): the client-safe half of the invoice document - its URL,
// its states and its money format. The document itself is built on the server (server/sponsors/invoice-doc.ts) and drawn twice,
// as a page (components/sponsors/invoice-view.tsx) and as a PDF (server/sponsors/invoice-pdf.ts); both read these.
//
// No I/O, no server import: Task 23's email builds the same link from here.
import type { MessageKey } from "@/lib/messages";

/** What an invoice says about its money (review I3: every way a deal ends unpaid, said truthfully):
 *  - `paid`, `refunded`: by the money;
 *  - `unpaid`: still due - including an OFFLINE deal that went live and then ended unpaid (its term ran out, or its competition
 *    finished): the sponsor had the placement, so the money is still owed and the invoice keeps its bank details;
 *  - `void`: the club ended the deal (End now) before it was paid - nothing is due;
 *  - `written_off`: an invoice still due after its deal ended, which the club waived (Task 23) - nothing is due;
 *  - `ended`: any other deal that ended unpaid (it never went live, or it was paid by card) - no claim either way: contact the
 *    club. */
export const INVOICE_STATES = ["paid", "unpaid", "refunded", "void", "written_off", "ended"] as const;
export type InvoiceState = (typeof INVOICE_STATES)[number];

/** Each state's stamp, and the line under it. Typed key maps - the i18n house rule bans dynamic keys. */
export const INVOICE_STATE_KEY: Record<InvoiceState, MessageKey> = {
  paid: "sponsors.invoice.state.paid",
  unpaid: "sponsors.invoice.state.unpaid",
  refunded: "sponsors.invoice.state.refunded",
  void: "sponsors.invoice.state.void",
  written_off: "sponsors.invoice.state.writtenOff",
  ended: "sponsors.invoice.state.ended",
};
export const INVOICE_STATE_NOTE_KEY: Record<Exclude<InvoiceState, "unpaid">, MessageKey> = {
  paid: "sponsors.invoice.stateNote.paid",
  refunded: "sponsors.invoice.stateNote.refunded",
  void: "sponsors.invoice.stateNote.void",
  written_off: "sponsors.invoice.stateNote.writtenOff",
  ended: "sponsors.invoice.stateNote.ended",
};

/** The line under the stamp, page and PDF alike (its `{club}` is the org's name): none on an invoice still due while its deal
 *  runs (the page says how to pay); "ended, and still due" on one whose deal has ended; else the state's own line. */
export function invoiceNoteKey(state: InvoiceState, dealEnded: boolean): MessageKey | null {
  if (state === "unpaid") return dealEnded ? "sponsors.invoice.stateNote.endedDue" : null;
  return INVOICE_STATE_NOTE_KEY[state];
}

/** The sponsor's invoice page: `/r/sponsor/invoice/<token>`, root-relative. The token is a bearer credential (32 random bytes);
 *  the scrubbers drop it (`/r/sponsor/invoice/` in lib/scrub-score-url.ts, matched BEFORE `/r/sponsor/`). */
export function invoicePath(token: string): string {
  return `/r/sponsor/invoice/${token}`;
}

/** The invoice page's one notice flag (`?notice=recording`): the pay route sends the sponsor back with it when Stripe says
 *  their card payment is complete and the payment webhook has not landed yet (409 `deal_paid_online`; T22 re-review M1). The
 *  page shows "your card payment is being recorded" instead of the pay button. A display hint only: the page reads nothing
 *  else from it, and a settled invoice ignores it. */
export const INVOICE_NOTICE_PARAM = "notice";
export const PAYMENT_RECORDING_NOTICE = "recording";

/** The invoice page with the "payment being recorded" notice. */
export function invoiceRecordingPath(token: string): string {
  return `${invoicePath(token)}?${INVOICE_NOTICE_PARAM}=${PAYMENT_RECORDING_NOTICE}`;
}

/** What every answer from the invoice's two routes (`/pdf`, `/pay`) carries: per request, never indexed, never a Referer - a
 *  redirect's own Referrer-Policy is what the browser follows to Stripe with, so the token stays out of Stripe's logs. */
export const INVOICE_PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

/** The PDF's file name: the invoice number, which is all `[A-Z0-9-]` (`formatInvoiceNumber`). */
export function invoiceFileName(number: string): string {
  return `${number}.pdf`;
}

/** An amount as an invoice prints it: the currency's own minor unit always shown (an invoice reads `£250.00`, never `£250`). */
export function invoiceMoney(locale: string, cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}
