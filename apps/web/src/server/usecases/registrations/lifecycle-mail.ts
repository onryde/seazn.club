import "server-only";
// The registrant's lifecycle mails (polish wave P2): what happens to an entry AFTER its confirmation - the payment landed, the organiser
// approved it, the unpaid place was released, the organiser withdrew it, a teammate joined it. One producer per outbox kind (see ./index.ts).
//
// Every producer runs INSIDE the transaction that records the fact it reports (the payment, the approval, the expiry...), at its own
// savepoint: the mail and the fact commit together or not at all, a fact the books lost is never mailed, and a mail that cannot be queued
// (no sealing key, a bad address, a render fault) never undoes the fact. A failure is logged and contained; it returns `null`.
// `null` also means "already queued" (the once-key): nothing more to attempt. A request path then makes the first attempt after commit
// (`deferred(() => dispatchNow(ids))`); a webhook or the sweep leaves it to the retry worker, as every other outbox mail does.
import { registrationPaidEmail } from "@/lib/email";
import { enqueueEmailOnce, expiryWithin, recipientLocale } from "@/server/email-outbox";
import { log } from "@/server/logger";
import type { Tx, RegistrationWithGroupRow } from "./types";
import { divisionCtx, fallbackOrigin } from "./lookups";

const divisionNameOf = async (db: Tx, divisionId: string): Promise<string> => {
  const [row] = await db<{ name: string }[]>`select name from divisions where id = ${divisionId}`;
  if (!row) throw new Error(`lifecycle mail: division ${divisionId} not found`);
  return row.name;
};

/** An entry's own status page, by reference code (`/r/<ref>`): token-less, so it is safe in any mail to the contact. */
const statusUrlOf = (origin: string, reg: RegistrationWithGroupRow): string | null => (reg.ref_code ? `${origin}/r/${reg.ref_code}` : null);

/** Run one producer at its own savepoint, contained: a failure is logged (never rendered, never thrown) and the caller's fact stands. */
async function contained<T>(tx: Tx, kind: string, regId: string, produce: (sp: Tx) => Promise<T>): Promise<T | null> {
  try {
    return (await tx.savepoint(produce)) as T;
  } catch (err) {
    log.error({ err, registrationId: regId, kind }, "registration: lifecycle email could not be queued");
    return null;
  }
}

/**
 * `registration_paid`: the payment landed - the card webhook (or the status page's reconcile), or the organiser marking an offline
 * payment. To the registration's contact, in their language; names THIS entry's own amount (never the cart's total).
 *
 * `confirmed` is what the entry IS after the write: `true` = confirmed, `false` = paid and waiting for the organiser's approval. The
 * caller reads it from the row (or the outcome of the very statement that wrote it), never from a rule it assumes: a division whose
 * approval is manual must not be told "you're confirmed".
 *
 * Once per payment: `paymentRef` is the Stripe payment intent (or, for an offline payment, the mark's own timestamp), so a replayed
 * webhook queues nothing and a LATER payment of the same entry (a re-promotion that pays again) is a new mail. The ref is the
 * registration, so a payment mail still waiting in the queue is superseded by the newer one rather than both going out.
 */
export async function queueRegistrationPaidMail(
  tx: Tx,
  a: { reg: RegistrationWithGroupRow; confirmed: boolean; paymentRef: string; origin?: string },
): Promise<string | null> {
  const { reg } = a;
  // A payment mail reports money: an entry with no fee has none to report (and a zero-amount mail would read as a charge of nothing).
  if (!(reg.amount_cents > 0)) return null;
  return contained(tx, "registration_paid", reg.id, async (sp) => {
    const origin = a.origin ?? fallbackOrigin();
    const ctx = await divisionCtx(sp, reg.division_id);
    const locale = await recipientLocale(sp, { pick: reg.locale, userId: reg.user_id, orgDefault: ctx.default_locale });
    const content = await registrationPaidEmail(
      {
        orgName: ctx.org_name,
        competitionName: ctx.comp_name,
        divisionName: await divisionNameOf(sp, reg.division_id),
        displayName: reg.display_name,
        contactName: reg.contact_name,
        refCode: reg.ref_code,
        amountCents: reg.amount_cents,
        currency: reg.currency,
        confirmed: a.confirmed,
        statusUrl: statusUrlOf(origin, reg),
      },
      locale,
    );
    return enqueueEmailOnce(sp, {
      kind: "registration_paid",
      refType: "registration",
      refId: reg.id,
      orgId: reg.org_id,
      to: reg.contact_email,
      ...content,
      transactional: false,
      expiresAt: expiryWithin(null),
      dedupeKey: `${reg.id}:${a.paymentRef}`,
    });
  });
}
