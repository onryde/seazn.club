import "server-only";
// The registrant's lifecycle mails (polish wave P2): what happens to an entry AFTER its confirmation - the payment landed, the organiser
// approved it, the unpaid place was released, the organiser withdrew it, a teammate joined it. One producer per outbox kind (see ./index.ts).
//
// Every producer runs INSIDE the transaction that records the fact it reports (the payment, the approval, the expiry...), at its own
// savepoint: the mail and the fact commit together or not at all, a fact the books lost is never mailed, and a mail that cannot be queued
// (no sealing key, a bad address, a render fault) never undoes the fact. A failure is logged and contained; it returns `null`.
// `null` also means "already queued" (the once-key): nothing more to attempt. A request path then makes the first attempt after commit
// (`deferred(() => dispatchNow(ids))`); a webhook or the sweep leaves it to the retry worker, as every other outbox mail does.
import { routes } from "@/lib/routes";
import { registrationApprovedEmail, registrationExpiredEmail, registrationPaidEmail } from "@/lib/email";
import { enqueueEmailOnce, expiryWithin, recipientLocale } from "@/server/email-outbox";
import { log } from "@/server/logger";
import type { Tx, RegistrationWithGroupRow, DivisionCtx } from "./types";
import { divisionCtx, fallbackOrigin } from "./lookups";

const divisionNameOf = async (db: Tx, divisionId: string): Promise<string> => {
  const [row] = await db<{ name: string }[]>`select name from divisions where id = ${divisionId}`;
  if (!row) throw new Error(`lifecycle mail: division ${divisionId} not found`);
  return row.name;
};

/** The competition's public pages exist only for a public or unlisted competition (a private one is a 404): a mail never links one. */
const hasPublicPages = (ctx: DivisionCtx): boolean => ctx.comp_visibility === "public" || ctx.comp_visibility === "unlisted";

/** The competition's public hub page, for a recipient who holds no status token (a teammate) - or `null` for a private competition. */
const competitionUrlOf = (origin: string, ctx: DivisionCtx): string | null =>
  hasPublicPages(ctx) ? `${origin}${routes.publicHub(ctx.org_slug, ctx.comp_slug)}` : null;

/** The competition's public registration page: how to register again - or `null` for a private competition. */
const registerUrlOf = (origin: string, ctx: DivisionCtx): string | null =>
  hasPublicPages(ctx) ? `${origin}${routes.publicRegister(ctx.org_slug, ctx.comp_slug)}` : null;

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

/**
 * `registration_approved`: the organiser approved the entry (Approve, Confirm, or Confirm-and-waive-the-fee), so its place is confirmed.
 * To the registration's contact AND to every teammate who has joined the entry and has an address (W2, W13); one mail per address (a
 * teammate whose address is the contact's own is not mailed twice). Each in their own language: the contact's pick or account, a teammate's account or the club's.
 *
 * `reg` is the row AFTER the write. Only an entry that is `confirmed` there is told it is: an approval that left the entry anywhere else
 * (the day Approve and Mark paid are split, an approved entry whose fee is still due) queues nothing here and says so in the log, because
 * "you're confirmed" is a claim about the row, not about what the organiser pressed. That wording is the next wave's to write.
 *
 * Once per recipient per approval: the keys carry the row's `updated_at`, which the approving statement stamps, so a second Approve of an
 * already-confirmed entry (it returns early, before this is reached) and a retried transaction queue nothing, while an entry withdrawn,
 * reinstated and approved AGAIN is a new approval and is mailed again.
 */
export async function queueRegistrationApprovedMails(tx: Tx, a: { reg: RegistrationWithGroupRow; origin?: string }): Promise<string[]> {
  const { reg } = a;
  if (reg.status !== "confirmed") {
    log.info({ registrationId: reg.id, status: reg.status }, "registration: approval did not confirm the entry; no approved email queued");
    return [];
  }
  // Each step at its own savepoint: one teammate's bad address must not cost the contact their mail, and none of it may cost the approval.
  const prep = await contained(tx, "registration_approved", reg.id, async (sp) => {
    const ctx = await divisionCtx(sp, reg.division_id);
    const mates = await sp<{ full_name: string; email: string; user_id: string | null }[]>`
      select full_name, btrim(email) as email, user_id
      from registration_players
      where registration_id = ${reg.id}
        and email is not null and btrim(email) <> ''
        and consent_status in ('granted', 'guardian')
      order by created_at, id`;
    return { ctx, divisionName: await divisionNameOf(sp, reg.division_id), mates: [...mates] };
  });
  if (!prep) return [];
  const origin = a.origin ?? fallbackOrigin();
  const stamp = reg.updated_at.toISOString();
  const base = {
    orgName: prep.ctx.org_name,
    competitionName: prep.ctx.comp_name,
    divisionName: prep.divisionName,
    displayName: reg.display_name,
    competitionUrl: competitionUrlOf(origin, prep.ctx),
  };
  // The contact first, then every teammate who has joined (consented) and left an address. One mail per ADDRESS, whatever the case or how
  // many rows carry it: the once-key below is that rule (a teammate who typed the contact's own address, or two rows for one person, queue
  // nothing a second time).
  const recipients = [
    { to: reg.contact_email, name: reg.contact_name, refCode: reg.ref_code, pick: reg.locale, userId: reg.user_id },
    ...prep.mates.map((m) => ({ to: m.email, name: m.full_name, refCode: null, pick: null, userId: m.user_id })),
  ];
  const queued: string[] = [];
  for (const r of recipients) {
    const id = await contained(tx, "registration_approved", reg.id, async (sp) => {
      const locale = await recipientLocale(sp, { pick: r.pick, userId: r.userId, orgDefault: prep.ctx.default_locale });
      const content = await registrationApprovedEmail({ ...base, recipientName: r.name, refCode: r.refCode }, locale);
      return enqueueEmailOnce(sp, {
        kind: "registration_approved",
        refType: "registration",
        refId: reg.id,
        orgId: reg.org_id,
        to: r.to,
        ...content,
        transactional: false,
        expiresAt: expiryWithin(null),
        dedupeKey: `${reg.id}:${r.to.toLowerCase()}:${stamp}`,
      });
    });
    if (id) queued.push(id);
  }
  return queued;
}

/**
 * `registration_expired`: the hourly sweep released an unpaid place (W10). To the contact, in their language: which entry, that its place
 * was released, and how to register again. In the sweep's own transaction, where the entry is written `expired`; the sweep has no
 * response to defer behind, so the retry worker makes the first attempt.
 *
 * One mail per ENTRY (a cart whose two entries both lapse tells the contact twice, once for each division: the mails differ by the division
 * they name). `reg` is the row as the sweep locked it, before it was written `expired`. Once per entry: `expired` is terminal, so the
 * entry's id is the key; a second sweep finds nothing overdue, and a direct second call queues nothing.
 */
export async function queueRegistrationExpiredMail(tx: Tx, a: { reg: RegistrationWithGroupRow; origin: string }): Promise<string | null> {
  const { reg } = a;
  return contained(tx, "registration_expired", reg.id, async (sp) => {
    const ctx = await divisionCtx(sp, reg.division_id);
    const locale = await recipientLocale(sp, { pick: reg.locale, userId: reg.user_id, orgDefault: ctx.default_locale });
    const content = await registrationExpiredEmail(
      {
        orgName: ctx.org_name,
        competitionName: ctx.comp_name,
        divisionName: await divisionNameOf(sp, reg.division_id),
        displayName: reg.display_name,
        contactName: reg.contact_name,
        refCode: reg.ref_code,
        registerUrl: registerUrlOf(a.origin, ctx),
      },
      locale,
    );
    return enqueueEmailOnce(sp, {
      kind: "registration_expired",
      refType: "registration",
      refId: reg.id,
      orgId: reg.org_id,
      to: reg.contact_email,
      ...content,
      transactional: false,
      expiresAt: expiryWithin(null),
      dedupeKey: `${reg.id}:expired`,
    });
  });
}
