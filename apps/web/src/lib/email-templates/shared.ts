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
 *  "15,00 £GB". Every registrant mail passes its recipient's language. A sender that names none - the sponsor, dispute and staff mails -
 *  keeps the en-GB spelling every mail wrote before (polish wave final fix m7: P4 had moved that default to "en", changing those mails
 *  with no test on them). */
export function money(cents: number, currency: string, locale = "en-GB"): string {
  return formatMoneyExact(cents, currency, locale);
}
