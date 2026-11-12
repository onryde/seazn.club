import "server-only";
// Organiser actions: confirm, mark paid, waive, remind, waitlist, withdraw, refund (see ./index.ts).
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { deferred } from "@/lib/deferred";
import { dispatchNow, enqueueEmail } from "@/server/email-outbox";
import type { AuthCtx } from "@/server/api-v1/auth";
import { fireDivisionRevalidate } from "@/server/public-site/revalidate";
import { assertNotFrozen, frozenCompetitionIds } from "../entitlement-freeze";
import { audit } from "../audit";
import type { RegistrationWithGroupRow } from "./types";
import { loadSettings, divisionCtx, orgReg, orgRegAfter } from "./lookups";
import { inviteUnclaimedMembers } from "./people";
import { materialise } from "./materialise";
import { openRegistrationSeatGateFor } from "./waitlist";
import { paymentReminderMessage, payDeadlineOf } from "./mail";
import { issuePayLink, recordPayToken } from "./pay-token";
import { stripeRefund, queueRefundReceipt } from "./refunds";
import { withdrawCore } from "./withdraw";
import { queueRegistrationApprovedMails, queueRegistrationPaidMail } from "./lifecycle-mail";
import { REMINDER_CAP_PER_DAY, REMINDER_LIMIT_CODE } from "@/lib/registration-reminder";
import { ownPaymentRefundedCents } from "@/lib/registration-status";

/** Organiser approve (free regs and waitlist overrides). Paid-division regs
 *  must be paid first — confirming an unpaid one would gift the spot. */
export async function confirmRegistration(auth: AuthCtx, regId: string): Promise<RegistrationWithGroupRow> {
  // Resolved BEFORE the transaction: the lookup queries the POOLED `sql` proxy
  // (`getLimit`), and `withTenant` pins a pooled connection for its whole
  // callback — see entitlement-freeze.ts. The set is keyed on the ORG, so it
  // needs no id the transaction has not read yet, and `assertNotFrozen` is pure.
  const frozen = await frozenCompetitionIds(auth.orgId);
  // The seat gate, asked out here for the same reason (online-seat-gate.ts): confirming seats the registrant.
  const seatGate = await openRegistrationSeatGateFor(auth, regId);
  const { row, mailIds } = await withTenant(auth.orgId, async (tx) => {
    const reg = await orgReg(tx, regId);
    if (reg.status === "confirmed") return { row: reg, mailIds: [] as string[] };
    // RULING A (RS002 W5 review, BLOCKER): rejected is terminal from EVERY
    // writer — an organiser explicitly confirming stays allowed on a manual
    // division (ruling B), but never on a REJECTED row regardless of mode.
    // Checked before the withdrawn check for the same reason: both are dead
    // ends, but rejected needs its own message.
    if (reg.status === "rejected") {
      throw new HttpError(422, "This registration was rejected and cannot be confirmed");
    }
    if (reg.status === "withdrawn") throw new HttpError(422, "registration is withdrawn");
    const settings = await loadSettings(tx, reg.division_id);
    // Polish wave P5 (P1 carry): THIS entry's own payment (V387), never the cart's (a sibling's payment sets the cart's intent).
    if ((settings?.fee_cents ?? 0) > 0 && reg.status !== "paid" && reg.entry_payment_intent_id === null) {
      throw new HttpError(
        422,
        "Awaiting payment — use Mark paid once the fee arrives, or Confirm without payment to waive it",
      );
    }
    const [div] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${reg.division_id}`;
    assertNotFrozen(frozen, div.competition_id);
    await materialise(tx, reg, settings?.entrant_kind ?? "individual", seatGate);
    await audit(tx, div.competition_id, auth.orgId, "registration.confirmed", {
      registration_id: regId,
      paid: reg.status === "paid",
    }, auth.userId);
    const after = await orgRegAfter(tx, regId);
    // Polish wave P2 (W2, W13): the organiser's confirm is an approval; the registrant is told in the same transaction.
    return { row: after, mailIds: await queueRegistrationApprovedMails(tx, { reg: after }) };
  }, seatGate?.tenant);
  // A request: the first attempt is made after the response.
  if (mailIds.length > 0) deferred(() => dispatchNow(mailIds));
  fireDivisionRevalidate(row.division_id);
  // RS008: fire-and-forget, strictly AFTER the transaction above has
  // committed. `row.entrant_id` is null on an early-return before
  // materialise() ever ran (never happens for this function today, but
  // harmless either way); the open-claim guard inside makes a repeat sweep
  // of an already-confirmed row a cheap no-op.
  if (row.entrant_id) void inviteUnclaimedMembers(row.org_id, row.entrant_id);
  return row;
}

/** Organiser: record an offline (cash/bank) payment — confirms in the same tx
 *  (payment = approval, spec §2). Card-paid rows are refused: their money
 *  trail lives on Stripe and must stay refundable there. */
export async function markRegistrationPaidOffline(
  auth: AuthCtx,
  regId: string,
): Promise<RegistrationWithGroupRow> {
  // Resolved BEFORE the transaction: the lookup queries the POOLED `sql` proxy
  // (`getLimit`), and `withTenant` pins a pooled connection for its whole
  // callback — see entitlement-freeze.ts. The set is keyed on the ORG, so it
  // needs no id the transaction has not read yet, and `assertNotFrozen` is pure.
  const frozen = await frozenCompetitionIds(auth.orgId);
  const seatGate = await openRegistrationSeatGateFor(auth, regId);
  const { row, mailIds } = await withTenant(auth.orgId, async (tx) => {
    const reg = await orgReg(tx, regId);
    // RULING A (RS002 W5 review, BLOCKER): rejected is terminal from every
    // writer. Already implied by the `!== "pending"` check below (rejected
    // is never pending), but explicit and first — self-documenting, and
    // matches the SAME guard on confirmRegistration/confirmRegistrationWaived
    // rather than relying on an allowlist to accidentally encode it.
    if (reg.status === "rejected") {
      throw new HttpError(422, "This registration was rejected and cannot be marked paid");
    }
    if (reg.status !== "pending") {
      throw new HttpError(422, `Only pending registrations can be marked paid (this one is ${reg.status})`);
    }
    // Polish wave P5 (P1 carry): paid by card means THIS entry's own payment, not the cart's - on a cart where only a sibling paid,
    // the cart's intent is the sibling's and the unpaid entry was refused here although it had paid nothing.
    if (reg.entry_payment_intent_id) {
      throw new HttpError(422, "This registration was paid by card — refund it on the payments trail instead");
    }
    const settings = await loadSettings(tx, reg.division_id);
    if ((settings?.fee_cents ?? 0) <= 0) {
      throw new HttpError(422, "This division has no entry fee");
    }
    const [div] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${reg.division_id}`;
    assertNotFrozen(frozen, div.competition_id);
    await tx`
      update registrations set status = 'paid', updated_at = now()
      where id = ${regId}`;
    // offline_marked_paid_at/by live on the cart now (V364).
    await tx`
      update registration_groups
      set offline_marked_paid_at = now(), offline_marked_paid_by = ${auth.userId}, updated_at = now()
      where id = ${reg.group_id}`;
    await materialise(tx, { ...reg, status: "paid" }, settings?.entrant_kind ?? "individual", seatGate);
    await audit(tx, div.competition_id, auth.orgId, "registration.offline_paid", {
      registration_id: regId,
      amount_cents: reg.amount_cents,
    }, auth.userId);
    const after = await orgRegAfter(tx, regId);
    // Polish wave P2 (W1, W3): "payment received" in the transaction that records it. The wording is what the entry IS after the write
    // (today a mark-paid materialises, so confirmed; the day it stops, the same read says "awaiting approval"). One mail per mark: the
    // mark's own timestamp is the payment ref, so a re-promoted entry marked paid again is a new mail. THIS entry only: an offline payment
    // is marked entry by entry, so its mail names that entry's own amount, never the cart's.
    const [mark] = await tx<{ at: Date }[]>`select offline_marked_paid_at as at from registration_groups where id = ${reg.group_id}`;
    const mailIds = await queueRegistrationPaidMail(tx, {
      regIds: [regId],
      paymentIntentId: null,
      paymentRef: `offline:${mark!.at.toISOString()}`,
    });
    return { row: after, mailIds };
  }, seatGate?.tenant);
  // A request: the first attempt is made after the response.
  if (mailIds.length > 0) deferred(() => dispatchNow(mailIds));
  fireDivisionRevalidate(row.division_id);
  // RS008: fire-and-forget, strictly AFTER the transaction above has
  // committed — see confirmRegistration's identical wiring for why.
  if (row.entrant_id) void inviteUnclaimedMembers(row.org_id, row.entrant_id);
  return row;
}

/** Organiser: confirm while waiving the fee (comped entry) — audited. */
export async function confirmRegistrationWaived(
  auth: AuthCtx,
  regId: string,
): Promise<RegistrationWithGroupRow> {
  // Resolved BEFORE the transaction: the lookup queries the POOLED `sql` proxy
  // (`getLimit`), and `withTenant` pins a pooled connection for its whole
  // callback — see entitlement-freeze.ts. The set is keyed on the ORG, so it
  // needs no id the transaction has not read yet, and `assertNotFrozen` is pure.
  const frozen = await frozenCompetitionIds(auth.orgId);
  const seatGate = await openRegistrationSeatGateFor(auth, regId);
  const { row, mailIds } = await withTenant(auth.orgId, async (tx) => {
    const reg = await orgReg(tx, regId);
    if (reg.status === "confirmed") return { row: await orgRegAfter(tx, regId), mailIds: [] as string[] };
    // RULING A (RS002 W5 review, BLOCKER): rejected is terminal from every
    // writer. Already implied by the allowlist below (rejected is neither
    // pending nor waitlisted), but explicit and first for the same reason as
    // markRegistrationPaidOffline's twin guard.
    if (reg.status === "rejected") {
      throw new HttpError(422, "This registration was rejected and cannot be confirmed");
    }
    if (!["pending", "waitlisted"].includes(reg.status)) {
      throw new HttpError(422, `Cannot confirm a ${reg.status} registration`);
    }
    const settings = await loadSettings(tx, reg.division_id);
    const [div] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${reg.division_id}`;
    assertNotFrozen(frozen, div.competition_id);
    await materialise(tx, reg, settings?.entrant_kind ?? "individual", seatGate);
    await audit(tx, div.competition_id, auth.orgId, "registration.fee_waived", {
      registration_id: regId,
      fee_cents: settings?.fee_cents ?? 0,
    }, auth.userId);
    const after = await orgRegAfter(tx, regId);
    // Polish wave P2 (W2, W13): a comped entry is approved by the organiser; the registrant is told in the same transaction.
    return { row: after, mailIds: await queueRegistrationApprovedMails(tx, { reg: after }) };
  }, seatGate?.tenant);
  // A request: the first attempt is made after the response.
  if (mailIds.length > 0) deferred(() => dispatchNow(mailIds));
  fireDivisionRevalidate(row.division_id);
  // RS008: fire-and-forget, strictly AFTER the transaction above has
  // committed — see confirmRegistration's identical wiring for why.
  if (row.entrant_id) void inviteUnclaimedMembers(row.org_id, row.entrant_id);
  return row;
}

/** Organiser: email an unpaid registrant a payment reminder linking their payment page (card and offline alike; P4). */
export async function sendPaymentReminder(
  auth: AuthCtx,
  regId: string,
  origin: string,
): Promise<{ sent: boolean }> {
  const reg = await withTenant(auth.orgId, (tx) => orgReg(tx, regId));
  const settings = await loadSettings(sql, reg.division_id);
  const fee = settings?.fee_cents ?? 0;
  if (fee <= 0) throw new HttpError(422, "This division has no entry fee.");
  if (reg.status !== "pending") {
    throw new HttpError(422, "Payment reminders only apply to pending registrations.");
  }
  const ctx = await divisionCtx(sql, reg.division_id);
  // The division's method first (an organiser may have switched it since the entry), then the cart's - the page's own rule.
  const method = (settings?.payment_method ?? reg.payment_method) === "stripe" ? "card" : "offline";
  const link = issuePayLink(origin);
  const message = await paymentReminderMessage(reg, ctx, {
    // The amount THIS entry was charged (the figure the payment page and Checkout use), never the division's live fee: an organiser
    // may have edited the fee since sign-up, and the mail must not quote a price the entry will not be asked for.
    feeCents: reg.amount_cents,
    // Division override first, org-wide fallback — same resolution as the
    // confirmation email; refCode personalises {{reference}}.
    paymentInstructions: settings?.payment_instructions ?? ctx.payment_instructions,
    method,
    payPageUrl: link.url,
    // The entry's own pay-by moment (polish wave W4): the sweep's reminder quotes one, so the organiser's must too.
    payDeadline: payDeadlineOf(reg),
    refCode: reg.ref_code,
  });
  // The row, its link's token and the audit entry are ONE transaction: an audit that fails queues no mail and records no token, and
  // a mail the outbox refuses leaves no "reminded" entry behind. The token's org is the entry's own (the tenant this tx runs as). The mail is then attempted at once; `sent` is whether THAT attempt was accepted. A provider that is down
  // answers `{ sent: false }` and the row stays queued for the retry worker. No once-key: a press is a deliberate mail.
  const id = await withTenant(auth.orgId, async (tx) => {
    // The cap: lock the entry, THEN count, so two concurrent presses at four serialise and exactly one gets the fifth.
    await tx`select 1 from registrations where id = ${reg.id} for update`;
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from competition_events
       where competition_id = ${ctx.competition_id}
         and type = 'registration.payment_reminded'
         and payload->>'registration_id' = ${reg.id}
         and created_at > now() - interval '24 hours'`;
    if (n >= REMINDER_CAP_PER_DAY) {
      throw new HttpError(429, `This entry has had ${REMINDER_CAP_PER_DAY} reminders in the last 24 hours. Try again later.`, REMINDER_LIMIT_CODE);
    }
    const queued = await enqueueEmail(tx, message);
    await recordPayToken(tx, { tokenHash: link.tokenHash, registrationId: reg.id, orgId: reg.org_id });
    await audit(tx, ctx.competition_id, auth.orgId, "registration.payment_reminded", { registration_id: regId }, auth.userId);
    return queued;
  });
  const sent = (await dispatchNow([id])).get(id) === "sent";
  return { sent };
}

/** Organiser: push a pending registration to the waitlist. */
export async function waitlistRegistration(auth: AuthCtx, regId: string): Promise<RegistrationWithGroupRow> {
  return withTenant(auth.orgId, async (tx) => {
    const reg = await orgReg(tx, regId);
    if (reg.status !== "pending") {
      throw new HttpError(422, `Only pending registrations can be waitlisted (this one is ${reg.status})`);
    }
    const [div] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${reg.division_id}`;
    await tx`
      update registrations set status = 'waitlisted', updated_at = now()
      where id = ${regId}`;
    await audit(tx, div.competition_id, auth.orgId, "registration.waitlisted", {
      registration_id: regId,
    }, auth.userId);
    return orgRegAfter(tx, regId);
  });
}

/** Organiser withdraw — same core as the registrant path (audited actor). */
export async function withdrawRegistrationOrganiser(
  auth: AuthCtx,
  regId: string,
): Promise<RegistrationWithGroupRow> {
  const reg = await withTenant(auth.orgId, async (tx) => orgReg(tx, regId));
  await withdrawCore(reg, auth.userId, "organiser");
  return withTenant(auth.orgId, async (tx) => orgRegAfter(tx, regId));
}

/** Manual refund (post-lock organiser discretion; partial allowed). */
export async function refundRegistration(
  auth: AuthCtx,
  regId: string,
  amountCents: number | undefined,
): Promise<RegistrationWithGroupRow> {
  const pre = await withTenant(auth.orgId, async (tx) => orgReg(tx, regId));
  // Read before the tenant transaction opens (a pooled read inside it waits on the connection it holds).
  const ctx = await divisionCtx(sql, pre.division_id);
  // Polish wave P5 (P1-review carry c): the cap is read, the money moved and the refund booked under ONE lock on the entry row. Two
  // refunds at once used to read the same cap before either booked, so both passed it and both moved money. The second now waits
  // for the first to commit and reads the cap it left. The lock is held across the Stripe call on purpose (a refund is rare and
  // per entry; a second refund of the same money is the failure being prevented). `orgReg` reads `for update` (entry and cart rows,
  // in the order checkout completion locks them).
  const { row, receiptId } = await withTenant(auth.orgId, async (tx) => {
    const reg = await orgReg(tx, regId);
    // Polish wave W8 (walkthrough s08b): THIS entry's own payment, never the cart's. The cart's `payment_intent_id` is set by
    // whichever entry paid last, so on a cart where only a sibling paid it named the sibling's payment, and Refund on the unpaid
    // entry sent real money back off it. An entry with no payment of its own has nothing to refund; null fails closed (V387/H1).
    const intent = reg.entry_payment_intent_id;
    if (!intent) throw new HttpError(422, "No payment to refund");
    // RS002 (V368): reg.refunded_cents is THIS entry's own column now (hazard 3
    // fixed) — a sibling's earlier refund can no longer drive this negative and
    // falsely report an untouched entry as "already fully refunded".
    // Polish wave P5 (carry b): and only what was sent back of its CURRENT payment counts - a late payment's refund (kept in the
    // history) is not this payment's, so a re-promoted entry that paid again is refundable in full.
    const remaining = reg.amount_cents - ownPaymentRefundedCents(reg);
    if (remaining <= 0) throw new HttpError(422, "Already fully refunded");
    const amount = amountCents ?? remaining;
    if (amount > remaining) {
      throw new HttpError(422, `Refund exceeds the remaining ${remaining} cents`);
    }
    // The key names THIS refund: the entry, what its books held when the cap was read (under the lock, so it only moves when a
    // refund is booked) and the amount. A retry of the same press after a failed booking is the same refund at Stripe; a second
    // legitimate partial refund of the same amount reads a different total and so is a different key.
    const refund = await stripeRefund(intent, amount, {
      idempotencyKey: `registration-refund:${regId}:${reg.refunded_cents}:${amount}`,
    });
    const [div] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${reg.division_id}`;
    // Additive on BOTH tables: this entry's own total (V368) and the cart's
    // accumulated total (V364) — never overwrite either.
    await tx`
      update registrations
      set refunded_cents = refunded_cents + ${amount}, updated_at = now()
      where id = ${regId}`;
    await tx`
      update registration_groups
      set refunded_cents = refunded_cents + ${amount}, refunded_at = now(), updated_at = now()
      where id = ${reg.group_id}`;
    // The receipt joins the refund's record and its audit entry: all three commit together, or none does.
    const receiptId = await queueRefundReceipt(tx, { reg, ctx, amountCents: amount, refundId: refund.id });
    await audit(tx, div.competition_id, auth.orgId, "registration.refunded", {
      registration_id: regId,
      amount_cents: amount,
      mode: "manual",
      stripe_refund_id: refund.id,
    }, auth.userId);
    return { row: await orgRegAfter(tx, regId), receiptId };
  });
  // A request: the first attempt is made after the response.
  if (receiptId !== null) deferred(() => dispatchNow([receiptId]));
  return row;
}
