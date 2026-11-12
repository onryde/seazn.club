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

/** An amount as a mail writes it. The same exact-minor-unit spelling the status page, the review step and the payment page use
 *  (`formatMoneyExact`; polish wave P3, W1: "£15" on a page and "£15.00" in its mail); the mails' own locale stays en-GB. */
export function money(cents: number, currency: string): string {
  return formatMoneyExact(cents, currency, "en-GB");
}
