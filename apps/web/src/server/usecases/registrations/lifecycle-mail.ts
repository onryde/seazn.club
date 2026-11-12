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
import { registrationApprovedEmail, registrationExpiredEmail, registrationJoinedEmail, registrationPaidEmail, registrationWithdrawnEmail } from "@/lib/email";
import { entryStanding, isTerminalRegistrationStatus } from "@/lib/registration-status";
import { enqueueEmailOnce, expiryWithin, recipientLocale } from "@/server/email-outbox";
import { log } from "@/server/logger";
import type { Tx, RegistrationWithGroupRow, DivisionCtx } from "./types";
import { divisionCtx, fallbackOrigin, loadSettings, regGroupCols } from "./lookups";

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
 * payment. To the registration's contact, in their language: ONE mail per payment, listing every entry THAT payment paid with its own
 * amount and standing (a card cart that pays three entries is one mail of three lines, never three mails; the cart-shaped ruling of the
 * confirmation mail). A single entry reads as the single-entry mail.
 *
 * It is told WHICH entries to consider (`regIds`: the ones the payment names) and reads everything else from the books, in the caller's
 * transaction: an entry is listed only if it is `paid` or `confirmed` NOW, has a fee, and (for a card payment) carries THIS payment's
 * intent - so a late payment for a withdrawn sibling, a duplicate payment and an unpaid entry are never reported as received. What each
 * entry IS (`confirmed`, or paid and waiting for the organiser) is the row's status after the write, never a rule assumed from the
 * division: a manual-approval entry is not told "you're confirmed".
 *
 * Once per payment: `paymentRef` is the Stripe payment intent (or session; for an offline payment, the mark's own timestamp), so a
 * replayed webhook queues nothing and a LATER payment of the same cart (a re-promotion that pays again) is a new mail. The mail is
 * referenced by the cart's first listed entry, so a payment mail still waiting in the queue is superseded by a newer one for the same
 * entry, never by a payment of a different one. Because it is derived from the books and once-keyed, a card payment that committed
 * its entries and then crashed before this ran is healed by Stripe's re-delivery of the event.
 *
 * Returns the queued ids: none when nothing qualified or the mail was already queued.
 */
export async function queueRegistrationPaidMail(
  tx: Tx,
  a: { regIds: string[]; paymentIntentId: string | null; paymentRef: string; origin?: string },
): Promise<string[]> {
  if (a.regIds.length === 0) return [];
  const rows = await contained(tx, "registration_paid", a.regIds[0]!, async (sp) =>
    sp<RegistrationWithGroupRow[]>`
      select ${regGroupCols(sp)}
        from registrations r join registration_groups g on g.id = r.group_id
       where r.id = any(${a.regIds}::uuid[])
         and r.status in ('paid', 'confirmed')
         and r.amount_cents > 0
         and (${a.paymentIntentId}::text is null or r.payment_intent_id = ${a.paymentIntentId})
       order by r.created_at, r.id`,
  );
  if (!rows || rows.length === 0) return [];
  // One mail per cart (a payment names one cart's entries; the grouping is the guard that makes it true).
  const carts = new Map<string, RegistrationWithGroupRow[]>();
  for (const r of rows) carts.set(r.group_id, [...(carts.get(r.group_id) ?? []), r]);
  const queued: string[] = [];
  for (const entries of carts.values()) {
    const lead = entries[0]!;
    const id = await contained(tx, "registration_paid", lead.id, async (sp) => {
      const origin = a.origin ?? fallbackOrigin();
      const ctx = await divisionCtx(sp, lead.division_id);
      const locale = await recipientLocale(sp, { pick: lead.locale, userId: lead.user_id, orgDefault: ctx.default_locale });
      const listed = await Promise.all(
        entries.map(async (e) => ({
          displayName: e.display_name,
          divisionName: await divisionNameOf(sp, e.division_id),
          amountCents: e.amount_cents,
          confirmed: e.status === "confirmed",
        })),
      );
      const content = await registrationPaidEmail(
        {
          orgName: ctx.org_name,
          competitionName: ctx.comp_name,
          contactName: lead.contact_name,
          refCode: lead.ref_code,
          currency: lead.currency,
          entries: listed as [(typeof listed)[number], ...typeof listed],
          statusUrl: statusUrlOf(origin, lead),
        },
        locale,
      );
      return enqueueEmailOnce(sp, {
        kind: "registration_paid",
        refType: "registration",
        refId: lead.id,
        orgId: lead.org_id,
        to: lead.contact_email,
        ...content,
        transactional: false,
        expiresAt: expiryWithin(null),
        dedupeKey: `${lead.id}:${a.paymentRef}`,
      });
    });
    if (id) queued.push(id);
  }
  return queued;
}

/** Who an entry's news reaches: the contact first, then every teammate who has JOINED (consented) and left an address. */
interface Audience {
  to: string;
  /** Greeted by this name (the contact's, or the teammate's own); never the entry's. */
  name: string;
  /** The quotable reference: the contact's, never a teammate's. */
  refCode: string | null;
  pick: string | null;
  userId: string | null;
}

const audienceOf = async (sp: Tx, reg: RegistrationWithGroupRow): Promise<Audience[]> => {
  const mates = await sp<{ full_name: string; email: string; user_id: string | null }[]>`
    select full_name, btrim(email) as email, user_id
    from registration_players
    where registration_id = ${reg.id}
      and email is not null and btrim(email) <> ''
      and consent_status in ('granted', 'guardian')
    order by created_at, id`;
  return [
    { to: reg.contact_email, name: reg.contact_name, refCode: reg.ref_code, pick: reg.locale, userId: reg.user_id },
    ...mates.map((m) => ({ to: m.email, name: m.full_name, refCode: null, pick: null, userId: m.user_id })),
  ];
};

/**
 * One mail per recipient, each at its own savepoint (one teammate's bad address must not cost the contact their mail, and none of it may
 * cost the fact it reports), each in their own language: the contact's pick or account, a teammate's account or the club's. `keyOf` is the
 * once-key: one mail per ADDRESS (lowercased), whatever the case or how many rows carry it, so a teammate who typed the contact's own
 * address, or two rows for one person, queue nothing a second time.
 */
async function fanOut(
  tx: Tx,
  a: {
    kind: "registration_approved" | "registration_withdrawn" | "registration_expired";
    reg: RegistrationWithGroupRow;
    defaultLocale: string | null;
    audience: Audience[];
    render: (r: Audience, locale: Awaited<ReturnType<typeof recipientLocale>>) => Promise<{ subject: string; html: string; text: string }>;
    keyOf: (r: Audience) => string;
  },
): Promise<string[]> {
  const queued: string[] = [];
  for (const r of a.audience) {
    const id = await contained(tx, a.kind, a.reg.id, async (sp) => {
      const locale = await recipientLocale(sp, { pick: r.pick, userId: r.userId, orgDefault: a.defaultLocale });
      const content = await a.render(r, locale);
      return enqueueEmailOnce(sp, {
        kind: a.kind,
        refType: "registration",
        refId: a.reg.id,
        orgId: a.reg.org_id,
        to: r.to,
        ...content,
        transactional: false,
        expiresAt: expiryWithin(null),
        dedupeKey: a.keyOf(r),
      });
    });
    if (id) queued.push(id);
  }
  return queued;
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
  const prep = await contained(tx, "registration_approved", reg.id, async (sp) => ({
    ctx: await divisionCtx(sp, reg.division_id),
    divisionName: await divisionNameOf(sp, reg.division_id),
    audience: await audienceOf(sp, reg),
  }));
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
  return fanOut(tx, {
    kind: "registration_approved",
    reg,
    defaultLocale: prep.ctx.default_locale,
    audience: prep.audience,
    render: (r, locale) => registrationApprovedEmail({ ...base, recipientName: r.name, refCode: r.refCode }, locale),
    keyOf: (r) => `${reg.id}:${r.to.toLowerCase()}:${stamp}`,
  });
}

/**
 * `registration_expired`: the hourly sweep released an unpaid place (W10). To the registration's contact AND to every teammate who has
 * joined the entry and has an address (the audience of the approval: a place released is news to the whole team), each in their own
 * language: which entry, that its place was released, and how to register again. In the sweep's own transaction, where the entry is
 * written `expired`; the sweep has no response to defer behind, so the retry worker makes the first attempt.
 *
 * One mail per ENTRY per address (a cart whose two entries both lapse tells the contact twice, once for each division: the mails differ by
 * the division they name). `reg` is the row as the sweep locked it, before it was written `expired`. Once per entry and address: `expired`
 * is terminal, so the entry's id and the address are the key; a second sweep finds nothing overdue, and a direct second call queues nothing.
 */
export async function queueRegistrationExpiredMails(tx: Tx, a: { reg: RegistrationWithGroupRow; origin: string }): Promise<string[]> {
  const { reg } = a;
  const prep = await contained(tx, "registration_expired", reg.id, async (sp) => ({
    ctx: await divisionCtx(sp, reg.division_id),
    divisionName: await divisionNameOf(sp, reg.division_id),
    audience: await audienceOf(sp, reg),
  }));
  if (!prep) return [];
  const base = {
    orgName: prep.ctx.org_name,
    competitionName: prep.ctx.comp_name,
    divisionName: prep.divisionName,
    displayName: reg.display_name,
    registerUrl: registerUrlOf(a.origin, prep.ctx),
  };
  return fanOut(tx, {
    kind: "registration_expired",
    reg,
    defaultLocale: prep.ctx.default_locale,
    audience: prep.audience,
    render: (r, locale) => registrationExpiredEmail({ ...base, contactName: r.name, refCode: r.refCode }, locale),
    keyOf: (r) => `${reg.id}:expired:${r.to.toLowerCase()}`,
  });
}

/**
 * `registration_withdrawn`: the ORGANISER withdrew the entry (W11). To the registration's contact AND to every teammate who has joined the
 * entry and has an address (the audience of the approval), each in their own language: which entry, which division, that it is withdrawn,
 * and where to ask. A registrant's own withdrawal is never mailed (they know; their refund has its own receipt): the caller decides who
 * withdrew, this decides whether the people are still OWED the news.
 *
 * `reg` is the row as the withdrawal locked it, BEFORE it was written `withdrawn`. An entry already in a terminal status (`expired` - the
 * sweep told them their place was released; `rejected` and `withdrawn` cannot reach a withdrawal at all) is not told again: a second,
 * contradictory mail helps nobody. In the withdrawal's own transaction, so the mail and the fact commit together; a request path, so the
 * caller makes the first attempt after the response.
 *
 * Once per entry and address: `withdrawn` is terminal, so the entry's id and the address are the key.
 */
export async function queueRegistrationWithdrawnMails(tx: Tx, a: { reg: RegistrationWithGroupRow }): Promise<string[]> {
  const { reg } = a;
  if (isTerminalRegistrationStatus(reg.status)) return [];
  const prep = await contained(tx, "registration_withdrawn", reg.id, async (sp) => ({
    ctx: await divisionCtx(sp, reg.division_id),
    divisionName: await divisionNameOf(sp, reg.division_id),
    audience: await audienceOf(sp, reg),
  }));
  if (!prep) return [];
  const base = {
    orgName: prep.ctx.org_name,
    competitionName: prep.ctx.comp_name,
    divisionName: prep.divisionName,
    displayName: reg.display_name,
  };
  return fanOut(tx, {
    kind: "registration_withdrawn",
    reg,
    defaultLocale: prep.ctx.default_locale,
    audience: prep.audience,
    render: (r, locale) => registrationWithdrawnEmail({ ...base, contactName: r.name, refCode: r.refCode }, locale),
    keyOf: (r) => `${reg.id}:withdrawn:${r.to.toLowerCase()}`,
  });
}

/**
 * `registration_joined`: a teammate claimed a slot on the entry, or took one, through its join link (W13). To THE JOINER's own address, in
 * their language (their account's, else the club's), telling them which entry they are on and honestly where it stands: a team that has not
 * paid or been approved is NOT "in" yet, and the mail says what it waits on.
 *
 * Runs in the join's own transaction, at its own savepoint: a join never fails for want of a mail. `to` is what the joiner typed: none (or only
 * blanks) is the empty case, nothing to mail, and the join stands. An entry already in a terminal status is not described as one the joiner is
 * on (the join link refuses those before it gets here; this is that assumption as a guard). The joiner holds no status token, so the mail
 * links the competition's public page (none for a private competition) and never the captain's reference code.
 *
 * Once per PLAYER ROW (`<player id>:joined`): a slot is claimed once, and two joiners on one entry are two mails to their own addresses.
 * A request path: the caller makes the first attempt after the response.
 */
export async function queueRegistrationJoinedMail(
  tx: Tx,
  a: { registrationId: string; playerId: string; playerName: string; to: string | null; userId: string | null; origin?: string },
): Promise<string | null> {
  const to = a.to?.trim() ?? "";
  if (to === "") return null;
  return contained(tx, "registration_joined", a.registrationId, async (sp) => {
    const [reg] = await sp<{ display_name: string; status: string; amount_cents: number; division_id: string; org_id: string }[]>`
      select display_name, status, amount_cents, division_id, org_id from registrations where id = ${a.registrationId}`;
    if (!reg) throw new Error(`lifecycle mail: registration ${a.registrationId} not found`);
    if (isTerminalRegistrationStatus(reg.status)) return null;
    const origin = a.origin ?? fallbackOrigin();
    const ctx = await divisionCtx(sp, reg.division_id);
    const settings = await loadSettings(sp, reg.division_id);
    const locale = await recipientLocale(sp, { pick: null, userId: a.userId, orgDefault: ctx.default_locale });
    const content = await registrationJoinedEmail(
      {
        orgName: ctx.org_name,
        competitionName: ctx.comp_name,
        divisionName: await divisionNameOf(sp, reg.division_id),
        displayName: reg.display_name,
        refCode: null,
        playerName: a.playerName,
        // The ONE standing definition (lib/registration-status.ts), shared with the join response so the mail and the page agree.
        state: entryStanding(reg.status, reg.amount_cents, settings?.approval ?? null),
        competitionUrl: competitionUrlOf(origin, ctx),
      },
      locale,
    );
    return enqueueEmailOnce(sp, {
      kind: "registration_joined",
      refType: "registration",
      refId: a.registrationId,
      orgId: reg.org_id,
      to,
      ...content,
      transactional: false,
      expiresAt: expiryWithin(null),
      dedupeKey: `${a.playerId}:joined`,
    });
  });
}
