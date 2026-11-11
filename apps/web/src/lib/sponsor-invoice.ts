// Sponsor invoices (plan 2026-11-07-sponsor-deals, Task 22; spec §7): the client-safe half of the invoice document - its URL,
// its states and its money format. The document itself is built on the server (server/sponsors/invoice-doc.ts) and drawn twice,
// as a page (components/sponsors/invoice-view.tsx) and as a PDF (server/sponsors/invoice-pdf.ts); both read these.
//
// No I/O, no server import: Task 23's email builds the same link from here.
import type { MessageKey } from "@/lib/messages";

/** What an invoice says about its money. `void`: the deal ended while still unpaid - the invoice is not due. */
export const INVOICE_STATES = ["paid", "unpaid", "refunded", "void"] as const;
export type InvoiceState = (typeof INVOICE_STATES)[number];

/** Each state's stamp, and the line under it (an unpaid invoice needs none: the page says how to pay). Typed key maps - the
 *  i18n house rule bans dynamic keys. */
export const INVOICE_STATE_KEY: Record<InvoiceState, MessageKey> = {
  paid: "sponsors.invoice.state.paid",
  unpaid: "sponsors.invoice.state.unpaid",
  refunded: "sponsors.invoice.state.refunded",
  void: "sponsors.invoice.state.void",
};
export const INVOICE_STATE_NOTE_KEY: Record<Exclude<InvoiceState, "unpaid">, MessageKey> = {
  paid: "sponsors.invoice.stateNote.paid",
  refunded: "sponsors.invoice.stateNote.refunded",
  void: "sponsors.invoice.stateNote.void",
};

/** The sponsor's invoice page: `/r/sponsor/invoice/<token>`, root-relative. The token is a bearer credential (32 random bytes);
 *  the scrubbers drop it (`/r/sponsor/invoice/` in lib/scrub-score-url.ts, matched BEFORE `/r/sponsor/`). */
export function invoicePath(token: string): string {
  return `/r/sponsor/invoice/${token}`;
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
