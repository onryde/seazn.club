import "server-only";
// The language a queued mail is rendered in (phase-3 spec, decision D4). A producer asks this once, when it renders the body, and
// passes the answer to its builder (`xxxEmail(..., locale)`); the outbox stores the rendered mail, so the language is fixed at enqueue.
import type { Tx, sql } from "@/lib/db";
import { DEFAULT_LOCALE, hasLocale, type Locale } from "@/lib/i18n-constants";

/**
 * D4: the explicit pick, then the linked account's locale, then the org default, then `en`.
 *
 *  - An invalid value at any step (an unknown code, the dev-only `en-XA`, a different case) falls through to the next: only a shipped
 *    locale (`hasLocale`) is ever returned.
 *  - The account step runs only when the caller has a link (`userId`). A person who is not linked to an account has none to follow, so
 *    nothing is looked up by address. A soft-deleted account is not a source either (`deleted_at is null`): its locale outlives the
 *    deletion only until the sweep scrubs it, and a person who asked to be forgotten is not followed.
 *  - A valid pick answers without a query.
 *
 * Reads on the handle it is given. Inside a tenant transaction pass the `tx`: a pooled read there would hold a second connection
 * while the first waits for it (#996).
 */
export async function recipientLocale(
  db: Tx | typeof sql,
  a: { pick: string | null; userId: string | null; orgDefault: string | null },
): Promise<Locale> {
  if (a.pick !== null && hasLocale(a.pick)) return a.pick;
  if (a.userId !== null) {
    const [account] = await db<{ locale: string | null }[]>`select locale from users where id = ${a.userId} and deleted_at is null`;
    if (account?.locale != null && hasLocale(account.locale)) return account.locale;
  }
  if (a.orgDefault !== null && hasLocale(a.orgDefault)) return a.orgDefault;
  return DEFAULT_LOCALE;
}
