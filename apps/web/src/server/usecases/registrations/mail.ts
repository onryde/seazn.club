import "server-only";
// Registration mail: cart confirmation (submit, resend) and the payment reminder message (see ./index.ts).
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { isTerminalRegistrationStatus } from "@/lib/registration-status";
import { registrationEmail, paymentReminderEmail } from "@/lib/email";
import type { RegistrationEmailArgs, RegistrationEmailInvite } from "@/lib/email-templates";
import { routes } from "@/lib/routes";
import { joinLinkPath } from "@/lib/join-link";
import { resolvePersonDisplayName } from "@/lib/name-display";
import { resolveVenueTz } from "@/lib/tz";
import { type Locale } from "@/lib/i18n-constants";
import { deferred } from "@/lib/deferred";
import {
  dispatchNow,
  enqueueEmail,
  expiryWithin,
  recipientLocale,
  type OutboxMessage,
} from "@/server/email-outbox";
import type { AuthCtx } from "@/server/api-v1/auth";
import { log } from "@/server/logger";
import { audit } from "../audit";
import type { RegistrationRow, RegistrationGroupRow, RegistrationWithGroupRow, DivisionCtx } from "./types";
import { loadSettings, divisionCtx, tokenMatchesHash, orgReg } from "./lookups";

/**
 * Assembles the CART-shaped confirmation mail for one group — every
 * CURRENT entry with its own display name/status/fee, the cart's total/
 * currency/deadline/ref code, and (for an offline cart with money owed)
 * the resolved payment instructions. Shared by the submit-time send
 * (`notifySubmitted`), the organiser resend action
 * (`resendRegistrationConfirmation`) and the dispute-evidence
 * reconstruction (`buildDisputeEvidence`) — one query decides what "this
 * cart's confirmation email" contains, the same re-select-fresh-state
 * convention `mintGroupCheckout` uses rather than trusting a caller's
 * snapshot. Returns null (never throws) for a nonexistent group or one
 * with no entries — should not happen in practice; kept as a defensive
 * no-op for the fire-and-forget submit-time caller.
 *
 * `token`: the plaintext access token, only ever available at the SUBMIT
 * moment (only its sha256 is stored afterwards). When given, `statusUrl`
 * carries it — the same full-access status-page URL shape
 * `createRegistrationCheckout`'s own `returnBase` builds. When null
 * (every other caller), it falls back to the token-less `/r/[ref]` page,
 * mirroring that same function's fallback.
 *
 * The Pay button (player payment page plan, P5 - owner decision): when the cart pays by card, still owes a fee and `token` is
 * given, it points at `statusUrl` - the cart's own token-bearing status page, our details-first page that pays the WHOLE cart
 * (a per-entry page would split one cart into separate charges) and never expires. Nothing is minted here: no Checkout
 * session, no pay-page token. The registrant's own resend (`resendRegistrationConfirmationPublic`) passes its token, so its mail
 * does carry the Pay button; without a token (the organiser's resend, dispute evidence) there is none.
 *
 * `locale` is the language the mail is WRITTEN in, resolved here (D4, the
 * phase-3 spec): the cart's explicit pick, then the linked account's locale,
 * then the organiser's public default, then `en` (`recipientLocale`). The
 * queued row stores the rendered mail, so the language is fixed when the
 * caller renders it. `orgId` is the organisation the outbox row belongs to.
 * Reads on the pool: call it BEFORE opening a tenant transaction, never inside
 * one (a pooled read inside `withTenant` holds a second connection, #996).
 */
export async function buildCartMail(
  groupId: string,
  origin: string,
  token: string | null,
): Promise<{ to: string; locale: Locale; orgId: string; competitionId: string; args: RegistrationEmailArgs } | null> {
  const [group] = await sql<
    Pick<
      RegistrationGroupRow,
      | "contact_name" | "contact_email" | "locale" | "ref_code" | "amount_cents" | "currency"
      | "expires_at" | "payment_method" | "competition_id" | "org_id" | "user_id"
    >[]
  >`
    select contact_name, contact_email, locale, ref_code, amount_cents, currency, expires_at,
           payment_method, competition_id, org_id, user_id
    from registration_groups where id = ${groupId}`;
  if (!group) {
    // Silent before RS005 F1: a caller (notifySubmitted, resendRegistration-
    // Confirmation, buildDisputeEvidence) just got a null it could not
    // explain — the dispute-evidence caller in particular falls back to a
    // placeholder that reads as "no receipt was sent" on a document
    // submitted to Stripe as evidence. Should not happen in practice
    // (registrations FK to their group), which is exactly why it needs a
    // trace when it does.
    log.error({ groupId }, "registration: buildCartMail found no group for this id — cart mail cannot be built");
    return null;
  }

  // Each entry with its division's name and review mode (polish wave W7): two entries for one person are otherwise the same line,
  // and "Pending" alone does not say whether the entry waits on a payment, an approval or both (`entryWaitingOn`). A division
  // with no settings row reviews nothing by hand, the same default the submit path uses.
  const entries = await sql<
    {
      id: string;
      division_id: string;
      display_name: string;
      status: RegistrationRow["status"];
      amount_cents: number;
      division_name: string;
      approval: "auto" | "manual";
      approved: boolean;
    }[]
  >`
    select r.id, r.division_id, r.display_name, r.status, r.amount_cents,
           d.name as division_name, coalesce(rs.approval, 'auto') as approval, r.approved_at is not null as approved
    from registrations r
    join divisions d on d.id = r.division_id
    left join registration_settings rs on rs.division_id = r.division_id
    where r.group_id = ${groupId}
    order by r.created_at, r.id`;
  if (entries.length === 0) {
    // Same "should not happen, but must not be invisible if it does" as the
    // !group branch above — see this function's own doc comment on this
    // defensive no-op.
    log.error({ groupId }, "registration: buildCartMail's group has no entries — cart mail cannot be built");
    return null;
  }

  const ctx = await divisionCtx(sql, entries[0]!.division_id);

  // The cart's payable subtotal, derived FRESH from the entries actually in
  // it right now — never `group.amount_cents` (RS005 F1 finding 2). That
  // column is a SUBMIT-TIME snapshot (registration-submit.ts's own
  // `subtotal`) with exactly one other writer: `promoteWaitlistedRow`
  // updates the promoted entry's own `registrations.amount_cents` but never
  // this mirror, so a cart mail rebuilt after a promotion (resend, dispute
  // evidence) read a stale 0 for an entry that now genuinely owes money.
  // Summing the live entries here — the same "non-waitlisted" rule
  // submit-time subtotal itself uses — self-heals regardless of which
  // entry-level writer last touched a fee, matching this function's own
  // re-select-fresh-state convention (see its doc comment re
  // `mintGroupCheckout`) rather than adding a second mirror write that can
  // drift again the next time a new promotion-shaped writer appears.
  const totalCents = entries.reduce(
    (sum, e) => sum + (e.status === "waitlisted" ? 0 : e.amount_cents),
    0,
  );

  // Same gate `notifyPromoted` uses for its single entry: offline AND money
  // actually owed — reading the SAME derived `totalCents` above, not the
  // stale column, for the identical reason (a promotion into an offline
  // cart must surface its instructions too).  A cart's paid divisions
  // share one payment_method (assertUniformPaymentMethod at submit), so
  // the first entry that still carries a fee is representative of the
  // whole cart, not a guess across divisions that disagree.
  let paymentInstructions: string | null = null;
  if (group.payment_method === "offline" && totalCents > 0) {
    const firstPaid = entries.find((e) => e.amount_cents > 0) ?? entries[0]!;
    const settings = await loadSettings(sql, firstPaid.division_id);
    paymentInstructions = settings?.payment_instructions ?? ctx.payment_instructions;
  }

  const statusUrl = token
    ? `${origin}${routes.publicRegisterStatus(ctx.org_slug, ctx.comp_slug)}?rid=${groupId}&token=${encodeURIComponent(token)}`
    : `${origin}/r/${group.ref_code}`;

  // What is still owed by card: the PENDING entries' fees. A cart whose every fee is settled (confirmed, waived, paid) gets no
  // Pay button even though its total is non-zero.
  const owedCents = entries.reduce((sum, e) => sum + (e.status === "pending" ? e.amount_cents : 0), 0);
  const payPageUrl = token && group.payment_method === "stripe" && owedCents > 0 ? statusUrl : null;
  // The join links are bearer capabilities, so they ride only a mail that already carries the cart token (the submit-time send and
  // the registrant's own resend): the organiser's resend and dispute evidence, which have none, carry none.
  const invites = token ? await cartInvites(groupId, entries, origin, ctx.org_slug, ctx.comp_slug) : [];

  return {
    to: group.contact_email,
    locale: await recipientLocale(sql, { pick: group.locale, userId: group.user_id, orgDefault: ctx.default_locale }),
    orgId: group.org_id,
    competitionId: group.competition_id,
    args: {
      orgName: ctx.org_name,
      competitionName: ctx.comp_name,
      contactName: group.contact_name,
      entries: entries.map((e) => ({
        displayName: e.display_name,
        divisionName: e.division_name,
        status: e.status,
        feeCents: e.amount_cents,
        approval: e.approval,
        approved: e.approved,
      })),
      totalCents,
      currency: group.currency,
      paymentInstructions,
      payPageUrl,
      payDeadline: group.expires_at,
      // The deadline is written in the organiser's own zone, the status page's spelling (polish wave P3, W4).
      timeZone: resolveVenueTz(null, ctx.org_timezone),
      statusUrl,
      refCode: group.ref_code,
      refStatusUrl: group.ref_code ? `${origin}/r/${group.ref_code}` : null,
      invites,
    },
  };
}

/**
 * "Invite your teammates" for the confirmation mail (polish wave P6; labelled per person in waves I and K): for each team / pair entry
 * of the cart that can still take people, in the entry order the mail lists them, the SAME links the status page's invite block
 * offers (`inviteLinks`, register/status/view-model.ts): one per roster slot still to join (`consent_status = 'pending'`, roster order,
 * named by the roster's own masked name), then for a team the general link. A pair has no general link (its roster is fixed at two),
 * so a complete pair has nothing and gets no block. Dead entries (withdrawn / rejected / expired), free agents and individual entries
 * have no join code to hand out, so they get no block. The links are capabilities: the caller only asks for them when it holds the
 * cart token, exactly like the Pay button.
 *
 * Nothing here says who was already emailed: nothing mails a typed, unclaimed teammate (`claim_invite` goes to a teammate who has
 * ALREADY joined and consented), so "already invited" would be a claim the product cannot make.
 */
async function cartInvites(
  groupId: string,
  entries: { id: string; display_name: string; division_name: string; status: string }[],
  origin: string,
  orgSlug: string,
  compSlug: string,
): Promise<RegistrationEmailInvite[]> {
  const rows = await sql<
    { id: string; join_code: string; entrant_kind: "team" | "individual" | "pair"; youth: boolean; player_name_display: string | null }[]
  >`
    select r.id, r.join_code, rs.entrant_kind, d.youth, d.player_name_display
    from registrations r
    join registration_settings rs on rs.division_id = r.division_id
    join divisions d on d.id = r.division_id
    where r.group_id = ${groupId} and r.join_code is not null and not r.free_agent`;
  if (rows.length === 0) return [];
  // The roster's own order and masking, as the status page reads them (group-status.ts): `order by rp.created_at`, and the name
  // through the same resolver with the linked person's consent and the division's policy.
  const pending = await sql<{ id: string; registration_id: string; full_name: string; person_consent: { public_name?: boolean } | null }[]>`
    select rp.id, rp.registration_id, rp.full_name, p.consent as person_consent
    from registration_players rp
    left join persons p on p.id = rp.person_id
    where rp.registration_id in ${sql(rows.map((r) => r.id))} and rp.consent_status = 'pending'
    order by rp.created_at`;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const invites: RegistrationEmailInvite[] = [];
  for (const e of entries) {
    const r = byId.get(e.id);
    if (!r || isTerminalRegistrationStatus(e.status)) continue;
    if (r.entrant_kind !== "team" && r.entrant_kind !== "pair") continue;
    const links: RegistrationEmailInvite["links"] = pending
      .filter((p) => p.registration_id === r.id)
      .map((p) => ({
        name: resolvePersonDisplayName(p.full_name, p.person_consent, r.player_name_display, r.youth),
        url: `${origin}${joinLinkPath(orgSlug, compSlug, r.join_code, p.id)}`,
      }));
    if (r.entrant_kind === "team") links.push({ name: null, url: `${origin}${joinLinkPath(orgSlug, compSlug, r.join_code)}` });
    if (links.length === 0) continue;
    invites.push({ displayName: e.display_name, divisionName: e.division_name, kind: r.entrant_kind, links });
  }
  return invites;
}

/** What `buildCartMail` returns for a cart that has something to say. */
type CartMail = NonNullable<Awaited<ReturnType<typeof buildCartMail>>>;

/**
 * The outbox message of one cart's confirmation: ONE place decides its kind, ref, recipient, transactionality and expiry, so the three
 * producers (the submit, the organiser's resend, the registrant's resend) cannot drift apart. The ref is the CART
 * (`registration_group/<group id>`), not an entry: the mail restates the whole cart, so a newer row for the same cart and address
 * supersedes an older one that has not reached the registrant (the replace rule), and there is no once-key (a resend is a deliberate
 * second mail). It is not transactional (the marketing suppression list applies), and it expires at the bound the writer holds every
 * row to (`expiryWithin(null)`: the mail has no end of its own). Rendered here, in the locale `buildCartMail` resolved, BEFORE any
 * transaction opens, so nothing is held open while the dictionary loads.
 */
async function cartConfirmationMessage(mail: CartMail, groupId: string): Promise<OutboxMessage> {
  return {
    kind: "registration_confirmation",
    refType: "registration_group",
    refId: groupId,
    orgId: mail.orgId,
    to: mail.to,
    ...(await registrationEmail(mail.args, mail.locale)),
    transactional: false,
    expiresAt: expiryWithin(null),
  };
}

/**
 * Post-submit confirmation (RS005 W4) — fire-and-forget, cart-shaped: every
 * entry in the group with its own status/fee, the group's payable total,
 * and (a card cart with a fee owed) a Pay button to the cart's own status
 * page, decided by `buildCartMail` - this function never mints anything,
 * and no Checkout url reaches the mail. A registrant who gets no mail because the outbox refused the row,
 * or because this function itself threw, still keeps a
 * committed, capacity-holding cart — that is the entire reason this wraps
 * everything in one try/catch, matching `notifyPromoted`'s contract
 * exactly: a mail failure must never fail the submit that already
 * committed.
 *
 * The mail is QUEUED on the email outbox (kind `registration_confirmation`) and its first attempt is
 * made after the response (`deferred`): the registrant is not kept waiting on the provider, and a
 * provider that is down leaves a durable row for the retry worker instead of a lost mail. The caller
 * (the register route) has already asked `assertOutboxCanQueue()` BEFORE committing the cart, so a
 * box that cannot seal the body refuses the submit rather than reaching the catch below.
 */
export async function notifySubmitted(
  groupId: string,
  origin: string,
  token: string,
): Promise<void> {
  try {
    const mail = await buildCartMail(groupId, origin, token);
    if (!mail) return; // buildCartMail already logged why
    const id = await enqueueEmail(sql, await cartConfirmationMessage(mail, groupId));
    deferred(() => dispatchNow([id]));
  } catch (err) {
    // RS005 F1 (owner: new code ships logging, 2026-08-12) — this used to
    // swallow silently. That is exactly how the single biggest finding of
    // this session went unnoticed for weeks: the confirmation send failed
    // and nothing recorded it. Still fire-and-forget — the point is that a
    // failure stops being invisible, not that submit starts failing.
    log.error({ err, groupId }, "registration: submit confirmation could not be queued");
  }
}

/**
 * Organiser: resend the cart's confirmation email (RS005 W4) — the WHOLE
 * cart `regId` belongs to, not just that one entry, since the mail itself
 * is cart-shaped. No fresh checkout is minted here (unlike the submit-time
 * send): the plaintext access token no longer exists once the cart is
 * committed (only its hash is stored), and re-minting a live Stripe session
 * on every resend click would leave a fresh abandoned session behind each
 * time for no ask in this wave — the registrant reaches payment through the
 * emailed status link, which already knows how to resume checkout.
 */
export async function resendRegistrationConfirmation(
  auth: AuthCtx,
  regId: string,
  origin: string,
): Promise<{ sent: boolean }> {
  const reg = await withTenant(auth.orgId, (tx) => orgReg(tx, regId));
  // A withdrawn/rejected/expired entry gets no confirmation. Observed live:
  // the organiser could resend on a WITHDRAWN entry and the send succeeded, so
  // someone who had pulled out received an email confirming their
  // registration — and because the mail is cart-shaped, it re-stated their
  // whole cart to them as though nothing had happened.
  //
  // Guarded HERE and not only in the UI: the button gate is a courtesy, this
  // is the rule. The route is reachable directly with a session or an API key.
  if (isTerminalRegistrationStatus(reg.status)) {
    // RS005 F1: an organiser clicking Resend and getting a 422 with nothing
    // recorded anywhere left no trace of who tried what on which entry.
    log.warn(
      { registrationId: regId, orgId: auth.orgId, actorId: auth.userId, status: reg.status },
      "registration: confirmation resend refused — entry is terminal",
    );
    throw new HttpError(
      422,
      `This registration is ${reg.status} — a confirmation would tell the registrant they are entered`,
    );
  }
  const mail = await buildCartMail(reg.group_id, origin, null);
  if (!mail) return { sent: false }; // buildCartMail already logged why
  const message = await cartConfirmationMessage(mail, reg.group_id);
  // The row and the audit entry are ONE transaction: an audit that fails queues no mail, and a mail the outbox refuses leaves no
  // "resent" entry behind. The mail is then attempted at once; `sent` is whether THAT attempt was accepted. A provider that is down
  // answers `{ sent: false }` and the row stays queued for the retry worker, which is the record of "it did not go out" (the old
  // per-click warn is gone: the outbox logs every attempt, with the row's id, where this one could only say "refused").
  const id = await withTenant(auth.orgId, async (tx) => {
    const queued = await enqueueEmail(tx, message);
    await audit(
      tx,
      mail.competitionId,
      auth.orgId,
      "registration.confirmation_resent",
      { registration_id: regId },
      auth.userId,
    );
    return queued;
  });
  const sent = (await dispatchNow([id])).get(id) === "sent";
  return { sent };
}

/**
 * Registrant self-service resend (RS007) — the token-gated sibling of
 * `resendRegistrationConfirmation` above. Keyed on the GROUP (`rid`), not one
 * entry: the confirmation mail is cart-shaped (`buildCartMail`), so gating on
 * one arbitrarily-picked entry's own status — the way the organiser path's
 * `regId` does — would refuse a resend for a cart that still has other
 * active entries. This refuses only once EVERY entry in the cart is
 * terminal.
 *
 * Unlike the organiser path — which never holds the plaintext token past
 * submit, only its hash survives — this path is called from the very page
 * that already has the real token in its URL, so it threads it through to
 * `buildCartMail`: the resent mail's `statusUrl` is the full rid+token
 * status page, not the masked `/r/[ref]` fallback `token: null` produces.
 */
export async function resendRegistrationConfirmationPublic(
  groupId: string,
  token: string,
  origin: string,
): Promise<{ sent: boolean }> {
  const [group] = await sql<
    Pick<RegistrationGroupRow, "org_id" | "competition_id" | "access_token_hash">[]
  >`
    select org_id, competition_id, access_token_hash
    from registration_groups where id = ${groupId}`;
  if (!group || !tokenMatchesHash(token, group.access_token_hash)) {
    throw new HttpError(404, "registration not found");
  }
  const entries = await sql<{ status: RegistrationRow["status"] }[]>`
    select status from registrations where group_id = ${groupId}`;
  if (entries.length === 0 || entries.every((e) => isTerminalRegistrationStatus(e.status))) {
    throw new HttpError(
      422,
      "This registration is no longer active — a confirmation would tell the registrant they are entered",
    );
  }
  const mail = await buildCartMail(groupId, origin, token);
  if (!mail) return { sent: false }; // buildCartMail already logged why
  const message = await cartConfirmationMessage(mail, groupId);
  // As the organiser's resend: the row and the audit entry are one transaction, then the first attempt is made at once.
  const id = await sql.begin(async (tx) => {
    const queued = await enqueueEmail(tx, message);
    await audit(tx, group.competition_id, group.org_id, "registration.confirmation_resent", { group_id: groupId }, null);
    return queued;
  });
  const sent = (await dispatchNow([id])).get(id) === "sent";
  return { sent };
}

/** The moment this entry's spot stops being held for payment, as a reminder should quote it: a promoted entry's OWN window
 *  (`promotion_expires_at`), the cart's shared deadline otherwise - the split the sweep's two reminder passes already use. `null`
 *  when there is none (an offline cart has no window) or it has already passed (the sweep has not expired the entry yet; "held
 *  until <a past moment>" would be false), so the mail falls back to its undated wording. */
export function payDeadlineOf(
  reg: Pick<RegistrationWithGroupRow, "promoted_at" | "promotion_expires_at" | "expires_at">,
  now: Date = new Date(),
): Date | null {
  const d = reg.promoted_at ? reg.promotion_expires_at : reg.expires_at;
  return d && new Date(d).getTime() > now.getTime() ? new Date(d) : null;
}

/**
 * The outbox message of one payment reminder: ONE place decides its kind, ref, recipient, transactionality and language, so the sweep's
 * two passes and the organiser's manual reminder cannot drift apart. Every reminder links the entry's payment page (`payPageUrl`),
 * never a Checkout url. The ref is the ENTRY (`registration/<reg id>`): a newer reminder
 * for the same entry fully restates the older one (fee, link, deadline), so it supersedes an older one the registrant has not read. It
 * is not transactional (the marketing suppression list applies). It is worthless once the pay window it names has closed
 * (`payDeadline`), and the manual reminder has no end of its own. The language is the registrant's (D4: the cart's pick, then the
 * linked account, then the organiser's default). Reads on the pool: call it BEFORE opening a tenant transaction (#996).
 */
export async function paymentReminderMessage(
  reg: RegistrationWithGroupRow,
  ctx: DivisionCtx,
  o: {
    feeCents: number;
    paymentInstructions: string | null;
    /** `card`: the page's Pay button; `offline`: the instructions plus the page's details link. */
    method: "card" | "offline";
    /** This entry's payment page (`issuePayLink`), whose token the caller records in the queueing transaction. */
    payPageUrl: string;
    /** The entry's pay-by moment, named in the card mail so the player knows how long the spot is held. The sweep passes the one it
     *  keyed on; the organiser's manual reminder passes the entry's own (`payDeadlineOf`). */
    payDeadline?: Date | null;
    refCode?: string | null;
  },
): Promise<OutboxMessage> {
  const locale = await recipientLocale(sql, { pick: reg.locale, userId: reg.user_id, orgDefault: ctx.default_locale });
  // Polish wave sign-off V5: the reminder names the entry's division (two entries for one person are otherwise the same name).
  const [division] = await sql<{ name: string }[]>`select name from divisions where id = ${reg.division_id}`;
  return {
    kind: "payment_reminder",
    refType: "registration",
    refId: reg.id,
    orgId: reg.org_id,
    to: reg.contact_email,
    ...(await paymentReminderEmail(
      {
        orgName: ctx.org_name,
        competitionName: ctx.comp_name,
        displayName: reg.display_name,
        divisionName: division?.name ?? "",
        contactName: reg.contact_name,
        feeCents: o.feeCents,
        currency: reg.currency,
        paymentInstructions: o.paymentInstructions,
        method: o.method,
        payPageUrl: o.payPageUrl,
        payDeadline: o.payDeadline,
        timeZone: resolveVenueTz(null, ctx.org_timezone),
        // Final fix round F: every reminder prints the reference, so it falls back to the cart's own when the caller passed none (the
        // sweep's card reminders).
        refCode: o.refCode ?? reg.ref_code,
      },
      locale,
    )),
    transactional: false,
    expiresAt: expiryWithin(o.payDeadline ?? null),
  };
}
