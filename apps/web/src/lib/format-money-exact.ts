// The one money spelling for a player's pages and mails (`formatMoneyExact`), in a module of its own with no imports: the email
// outbox core reaches it through `lib/email-templates/shared.ts`, and `lib/currency.ts` (which re-exports it for the pages) pulls in
// the plan catalogue JSON, which the core must not depend on (email-outbox no-import-cycle, ruling R1).

/**
 * An amount exactly as a registration surface prints it: the currency's own minor unit ALWAYS shown ("£15.00", never "£15").
 *
 * The one money spelling for a player's pages (the entries cart, the review step, the status page, the payment page). `formatMinor`
 * (`currency.ts`) drops the decimals of a whole amount, which is right for a pricing page and wrong beside a mail, Checkout and a payment page
 * that all write "£15.00" (polish wave P3, walkthrough W1). Every registration currency is a 2-decimal one (`REGISTRATION_CURRENCIES`),
 * so the currency's default fraction digits ARE two. An unknown code never throws into a render: it prints the plain number and the
 * code.
 */
export function formatMoneyExact(amountMinor: number, currency: string, locale = "en"): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: currency.toUpperCase() }).format(amountMinor / 100);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}
