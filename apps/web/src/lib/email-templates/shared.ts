// Shared text helpers for the email templates. HTML structure lives in the
// ./html files and is composed by ./compose.ts.
import { formatMoneyExact } from "@/lib/currency";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** An amount as a mail writes it: the same spelling the status page, the review step and the payment page use (`formatMoneyExact`), in the
 *  language the mail is written in. P3 (W1) made the digits agree ("£15" on a page, "£15.00" in its mail); P4 made the symbol agree - the
 *  mail was pinned to en-GB, which writes a dollar "US$15.00" where the page writes "$15.00", and a French mail "£15.00" beside the page's
 *  "15,00 £GB". A sender that names no language gets English, which is what every mail without a recipient locale already writes. */
export function money(cents: number, currency: string, locale = "en"): string {
  return formatMoneyExact(cents, currency, locale);
}
