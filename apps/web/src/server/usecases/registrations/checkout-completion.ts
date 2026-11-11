import "server-only";
// Payment completion: the checkout webhooks, confirmPaidRegistration, reconcile-on-return (see ./index.ts).
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { getStripe } from "@/lib/stripe";
import { rateLimit } from "@/lib/rate-limit";
import { log } from "@/server/logger";
import { fireDivisionRevalidate } from "@/server/public-site/revalidate";
import { FIRST_PAID_EARN, tryEarnGrant } from "@/lib/credits";
import { audit } from "../audit";
import type { RegistrationGroupRow, RegistrationWithGroupRow } from "./types";
import { hashRegistrationToken } from "./helpers";
import { regGroupCols, loadSettings, divisionCtx, regByRef, tokenMatchesHash, GROUP_ID_RE } from "./lookups";
import { inviteUnclaimedMembers } from "./people";
import { materialise } from "./materialise";
import { checkoutRegistrationIds } from "./checkout";
import { stripeRefund, queueRefundReceipt, errText, maybeAlertRegistrationRefundFailed } from "./refunds";

/**
 * Payment-integrity fix: `createRegistrationCheckout` freezes
 * `transfer_data.destination` from the org's `stripe_account_id` AT MINT
 * TIME (stamped onto `metadata.destination_account`, alongside
 * `fee_percent`, above). If the org reconnects a DIFFERENT Stripe account
 * before a still-open session is paid, Stripe has ALREADY routed the charge
 * to the frozen (now stale) destination by the time this webhook fires —
 * there is nothing left here to redirect, and `stripeRefund`'s
 * `reverse_transfer: true` would fail against an account this platform no
 * longer holds besides. Deliberately does NOT block, refund, or leave the
 * entry pending — the registrant paid in good faith and must not lose their
 * place over an organiser-side reconnect; this only records the drift for
 * the organiser console. Metadata absent (every session minted before this
 * change) means "cannot tell", and is always treated that way, never as a
 * mismatch — same fallback shape as `chargedFeePercent` below.
 *
 * Resolved off `regIds[0]` (already parsed by the caller via
 * `checkoutRegistrationIds`, always non-empty by the time this is called)
 * rather than `session.metadata.registration_group_id` — every entry named
 * in one session shares one group's org/competition, so any one of them is
 * enough, and this mirrors `handleRegistrationCheckoutAsyncPaymentFailed`'s
 * own registrations→divisions resolution below rather than adding a second,
 * parallel lookup path off a metadata field nothing else in this file reads.
 *
 * Review fixup (HIGH): the whole body is wrapped in try/catch, the same
 * shape as `expireSupersededCheckoutSession` above — a transient failure on
 * this function's OWN select or its OWN audit insert used to propagate out
 * of `handleRegistrationCheckoutCompleted` and abort the confirmPaidRegistration
 * loop that runs after it, contradicting this doc comment's own "does NOT
 * block, refund, or leave the entry pending". Telemetry must never be able
 * to break the path it observes.
 *
 * Review fixup (LOW): also idempotent against a redelivery. This function
 * can run more than once for the SAME session — `checkout.session.completed`
 * and `checkout.session.async_payment_succeeded` both dispatch through
 * `handleRegistrationCheckoutCompleted` (billing-events/), and Stripe's own
 * retry re-enters it whenever `billing_events.processed_at` stays null (a
 * later failure elsewhere in the same event, or Stripe's plain at-least-once
 * delivery). Unlike `confirmPaidRegistration`, this path is audit-only and
 * has no status column of its own to short-circuit on, so it checks the
 * ledger it writes to instead — the same "read state, then act" shape as
 * confirmPaidRegistration's status check and the late-refund path's
 * `refunded_cents` guard below, applied to the one thing an audit-only path
 * actually has: a matching row already on record for this exact session.
 */
async function checkDestinationAccountDrift(
  session: Stripe.Checkout.Session,
  regIds: string[],
  paymentIntentId: string | null,
): Promise<void> {
  try {
    const mintedDestination = session.metadata?.destination_account;
    if (!mintedDestination) return;
    const [row] = await sql<
      { org_id: string; competition_id: string; stripe_account_id: string | null }[]
    >`
      select r.org_id, d.competition_id, o.stripe_account_id
      from registrations r
      join divisions d on d.id = r.division_id
      join organizations o on o.id = r.org_id
      where r.id = ${regIds[0]!}`;
    if (!row || row.stripe_account_id === mintedDestination) return;
    const [already] = await sql<{ n: number }[]>`
      select 1 as n from competition_events
      where type = 'registration.destination_account_mismatch'
        and payload->>'checkout_session_id' = ${session.id}
      limit 1`;
    if (already) return; // redelivery of a drift already on record — silent no-op
    log.error(
      {
        registrationId: regIds[0],
        orgId: row.org_id,
        mintedDestination,
        currentDestination: row.stripe_account_id,
        sessionId: session.id,
        paymentIntentId,
      },
      "registration: destination account changed since checkout was minted — funds routed to the old account",
    );
    await audit(
      sql,
      row.competition_id,
      row.org_id,
      "registration.destination_account_mismatch",
      {
        checkout_session_id: session.id,
        payment_intent_id: paymentIntentId,
        minted_destination_account: mintedDestination,
        current_destination_account: row.stripe_account_id,
      },
      null,
    );
  } catch (err) {
    log.error(
      { err, sessionId: session.id, registrationId: regIds[0] },
      "registration: destination-account drift check failed — fulfilment continues",
    );
  }
}

/**
 * Fulfilment for a `registration_group` checkout session (RS003 W3b —
 * re-keyed from a single `registration_id` to the group's comma-joined
 * `registration_ids`, W3a's `createRegistrationCheckout`): every NAMED entry
 * is confirmed, never a sibling outside that list.
 *
 * The SINGLE gate on `payment_status` for this kind, deliberately, so none of
 * its three callers has to remember one: the `checkout.session.completed`
 * AND `checkout.session.async_payment_succeeded` dispatch branches
 * (billing-events/) both call straight through, and so do the two
 * reconcile-on-return paths below. Before this wave the dispatch branch had
 * NO gate at all — every sibling kind in that file already checked
 * `payment_status`, this one didn't — so a delayed-notification payment
 * method's `checkout.session.completed` (fired while still `unpaid`; the
 * success arrives later on `async_payment_succeeded` — Stripe skill,
 * "Webhooks and fulfillment") would have confirmed and materialised an
 * entrant before any money actually moved.
 *
 * `session.amount_total` is deliberately NOT forwarded to
 * `confirmPaidRegistration`, and that function no longer takes an amount at
 * all. `amount_total` is the CART's total across every named entry, so
 * feeding it in per-entry would smear the whole cart's sum onto each entry's
 * own `amount_cents` — and, worse, onto a late/duplicate refund, which reads
 * that same value. Each entry's own `amount_cents` is already exactly what
 * `createRegistrationCheckout` charged it, so it is the only correct source.
 *
 * The parameter was removed rather than passed `null`: this is its only
 * non-test caller, so every `amountTotal ?? …` fallback had an unreachable
 * non-null side, three of them in refund math. Left in place it reads like
 * "the amount actually charged" and invites precisely the smear above back.
 */
export async function handleRegistrationCheckoutCompleted(
  session: Stripe.Checkout.Session,
): Promise<void> {
  if (session.payment_status !== "paid") return;
  const regIds = checkoutRegistrationIds(session);
  if (regIds.length === 0) return;
  const paymentIntent =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : (session.payment_intent?.id ?? null);
  // The rate THIS session was billed at (see createRegistrationCheckout). Absent
  // on sessions minted before V312 — the stamp falls back to reg.fee_percent.
  const raw = session.metadata?.fee_percent;
  const chargedFeePercent =
    raw != null && raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : null;
  // Payment-integrity fix: detect (never block on) a Connect account that
  // changed since this session was minted. Session-scoped, so it runs once
  // per webhook, not once per named entry.
  await checkDestinationAccountDrift(session, regIds, paymentIntent);
  // Sequential, not Promise.all, and no per-id try/catch: each call is its
  // own locked transaction, so a failure partway through must abort the rest
  // and leave the WHOLE event unprocessed (billing_events.processed_at stays
  // null) for Stripe's retry — every entry already flipped is idempotent on
  // replay, but silently swallowing one entry's failure here would land the
  // event as "processed" while that one entry stays paid-for and unconfirmed
  // forever, with nothing left to retry it.
  for (const regId of regIds) {
    await confirmPaidRegistration(regId, paymentIntent, chargedFeePercent);
  }
}

/**
 * Delayed-notification counterpart of the handler above
 * (`checkout.session.async_payment_failed` — Stripe skill, "Webhooks and
 * fulfillment"): the payment that looked pending never landed.
 * `handleRegistrationCheckoutCompleted` never ran fulfilment for this session
 * (it gates on `payment_status`, and a failed session never reaches `paid`),
 * so there is nothing to undo — every named entry is left exactly where it
 * is, still `pending`, still payable. Only the failure is recorded, the same
 * "audit but do not act" shape as `registration.refund_failed` above.
 */
export async function handleRegistrationCheckoutAsyncPaymentFailed(
  session: Stripe.Checkout.Session,
): Promise<void> {
  const regIds = checkoutRegistrationIds(session);
  if (regIds.length === 0) return;
  const rows = await sql<{ id: string; org_id: string; competition_id: string }[]>`
    select r.id, r.org_id, d.competition_id
    from registrations r join divisions d on d.id = r.division_id
    where r.id in ${sql(regIds)}`;
  for (const row of rows) {
    await audit(
      sql,
      row.competition_id,
      row.org_id,
      "registration.payment_failed",
      { registration_id: row.id, checkout_session_id: session.id },
      null,
    );
  }
}

type PayOutcome =
  /** `entrantId` is nullable since RS009: `materialise` seats no entrant for
   *  a solo sign-up (design §6 — they are fielded through the team they are
   *  assigned to), so a paid solo sign-up confirms with none. The `as unknown
   *  as PayOutcome` cast below meant a `string` here compiled anyway and fed
   *  null straight into inviteUnclaimedMembers, whose own parameter is
   *  `string`. Runtime was a harmless no-op query; the type was a lie, and
   *  the next non-null dereference of it would have compiled too. */
  | { kind: "confirmed"; divisionId: string; competitionId: string; orgId: string; entrantId: string | null }
  // RULING B (RS002 W5 review): a Stripe payment is the MACHINE, not the
  // organiser — on a manual-approval division it leaves the entry at 'paid'
  // and waits for a human (approveRegistration). Distinct from "confirmed"
  // so the growth-loop earn grants below (keyed on a genuine confirmation)
  // never fire for a payment still awaiting review.
  | { kind: "paid_awaiting_approval"; divisionId: string; competitionId: string }
  | { kind: "late" | "duplicate"; reg: RegistrationWithGroupRow; competitionId: string; intent: string }
  | null;

async function confirmPaidRegistration(
  regId: string,
  paymentIntentId: string | null,
  chargedFeePercent: number | null = null,
): Promise<void> {
  const outcome = (await sql.begin(async (tx) => {
    const [reg] = await tx<RegistrationWithGroupRow[]>`
      select ${regGroupCols(tx)}
      from registrations r join registration_groups g on g.id = r.group_id
      where r.id = ${regId} for update`;
    if (!reg) return null;
    const [div] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${reg.division_id}`;
    // Already paid/confirmed: a replay of the SAME session is a no-op, but a
    // DIFFERENT intent means the registrant paid twice (two open checkout
    // tabs, spec issue #2) — refund the duplicate, keep the original.
    if (reg.status === "confirmed" || reg.status === "paid") {
      // V387/H1: compare against THIS ENTRY's intent, never the cart's. The
      // cart column is last-writer-wins, so on a two-session cart (a promoted
      // sibling paying in its own session) it holds the SIBLING's intent by
      // the time a webhook for this entry replays — and this comparison would
      // then read a legitimate replay of PI_A as a duplicate and refund it.
      // Falls back to the cart column only when the entry has none recorded,
      // which is a pre-V387 row: same behaviour as before for those.
      const ownIntent = reg.entry_payment_intent_id ?? reg.payment_intent_id;
      if (paymentIntentId && ownIntent && paymentIntentId !== ownIntent) {
        return { kind: "duplicate", reg, competitionId: div.competition_id, intent: paymentIntentId };
      }
      return null;
    }
    // Money landing on a dead registration (withdrawn/expired/rejected, spec
    // issue #1 + RULING A, RS002 W5 review BLOCKER — the worst finding of
    // the session): record the intent for the audit trail and send it
    // straight back, NEVER confirm. A rejected reg with a live
    // payment_intent_id used to fall through to the branch below and be
    // silently confirmed — with an entrant materialised — on a late or
    // replayed webhook. Rejected reuses this exact path unchanged: refund,
    // never confirm, is precisely what "the organiser said no" requires.
    // payment_intent_id lives on the cart now (V364).
    //
    // REVIEW FIX (money-path defect #2): 'waitlisted' added to this list.
    // A promoted entry that misses its OWN promotion_expires_at window
    // lapses back to 'waitlisted' (V378/RS007's sweep lapse pass) — it is
    // exactly as dead as withdrawn/expired/rejected here: its slot has
    // already been re-offered to the next waitlist candidate by the time a
    // late/in-flight checkout completes. Without this, the payment silently
    // fell through to the branch below (status='paid', then materialised on
    // auto-approval) — an entrant seated in a slot the sweep had already
    // handed to someone else, and the late payer never refunded.
    //
    // Finding #18 (money-matrix S4, CRITICAL): 'withdrawn' is reachable two
    // structurally different ways, and reg.status alone cannot tell them
    // apart. (a) The row was NEVER paid/confirmed — it was cancelled before
    // any money moved, and a stale checkout now completes for a spot the
    // entrant never held; that is exactly what the branch below exists for
    // (refund in full, ignore refund_lock_at — the organiser never had a
    // seated entrant to keep the money for). (b) The row WAS confirmed —
    // materialise() already ran, an entrant was seated — and was withdrawn
    // AFTERWARDS: the ordinary post-lock cancellation refund_lock_at exists
    // to govern. Reaching this function again for case (b) is not a late
    // payment; it is a REPLAY of an already-fulfilled payment.
    // reconcileRegistrationGroupBySession (the status page's
    // reconcile-on-return, register/status/page.tsx) deliberately has no
    // status pre-check — a multi-entry cart can have a settled
    // representative sibling — so cancel-entry.tsx's router.refresh() right
    // after a successful withdrawal re-renders the SAME URL (same
    // ?checkout=success&session_id=... query string) and re-enters here
    // with the SAME session, which Stripe still happily reports as paid —
    // a refund never changes a Checkout Session's own payment_status.
    // Refunding again here would silently overrule withdrawCore's own
    // already-correct policy decision for this entry.
    //
    // Finding #18b (the residual gap #18 left open): #18 shipped this guard
    // keyed on `entrant_id` — which only answers "was this entry ever
    // SEATED". `entrant_id` is written by materialise(), and materialise()
    // only runs on the auto-approval path a few lines below (or once an
    // organiser later approves it). On a MANUAL-approval division, RULING B
    // (above) stops confirmPaidRegistration's own auto-approval branch
    // short: the entry sits at status = 'paid', a REAL charge already on
    // it, entrant_id still null, awaiting the organiser's decision. If it
    // is withdrawn from there — refund_lock_at long past, withdrawCore
    // correctly declines to refund (its own `locked.status === 'paid'`
    // branch already treats 'paid' as "genuinely charged") — the identical
    // reconcile replay #18 pinned reads entrant_id null and falls straight
    // through to the unconditional refund below. Same bug, narrower
    // population (manual-approval divisions only), same money leaving past
    // the lock.
    //
    // `charged_at` (added alongside this fix) answers the question this
    // branch actually needs answered — "did a live charge exist for THIS
    // entry before it was withdrawn" — directly, for both approval modes:
    // it is stamped in the SAME statement that writes `status = 'paid'`,
    // before the manual/auto fork, so a manual-approval entry gets it exactly
    // as reliably as an auto-approval one. `entrant_id` is a strict subset
    // (every row materialise() ever touches was charged_at-stamped first, in
    // the same earlier statement of this same function), so this replaces
    // rather than supplements it — one durable signal, not two overlapping
    // ones. Like entrant_id, nothing ever clears it: withdrawCore only
    // flips the linked ENTRANT row's own status (if one was ever
    // materialised), never registrations.charged_at.
    //
    // Scoped to 'withdrawn' alone, by construction (the condition above
    // only matches that one status) — 'expired'/'rejected'/'waitlisted'
    // fall through to the unconditional refund below completely unchanged,
    // regardless of charged_at. That is correct independent of this guard:
    // only withdrawCore can ever act on an already-'paid'/'confirmed' row,
    // and nothing else in this branch reaches it. 'expired'/'waitlisted'
    // only ever fire from a still-'pending' row (sweepRegistrations' own
    // `locked.status !== "pending"` guards on both its expiry and lapse
    // passes) — charged_at would be null there regardless. 'rejected' is
    // reachable from 'paid' too (rejectRegistration explicitly allows it,
    // RULING B's declined counterpart), but rejectRegistration refunds a
    // paid entry directly, in its own call, and never writes 'withdrawn' —
    // so a rejected row never reaches this guard at all, whatever
    // charged_at holds.
    if (reg.status === "withdrawn" && reg.charged_at) {
      // PR #677 finding H2. Returning null unconditionally kept a genuinely
      // DUPLICATE charge: two open tabs, S1 pays and the entry is confirmed,
      // the entry is withdrawn past the refund lock (correctly unrefunded),
      // then S2 completes with a different intent — money neither refunded,
      // nor recorded, nor audited.
      //
      // Symmetric with the paid/confirmed branch above rather than the fix
      // first proposed in review (`&& paymentIntentId === reg.payment_intent_id`),
      // which would let a differing intent fall through to the `late` branch
      // below — and that branch refunds `reg.payment_intent_id ?? paymentIntentId`,
      // i.e. the FIRST intent. It would have refunded the original charge,
      // the one this guard exists to let the organiser keep, and still left
      // the duplicate sitting there.
      const ownIntent = reg.entry_payment_intent_id ?? reg.payment_intent_id;
      if (paymentIntentId && ownIntent && paymentIntentId !== ownIntent) {
        return { kind: "duplicate", reg, competitionId: div.competition_id, intent: paymentIntentId };
      }
      return null;
    }
    if (
      reg.status === "withdrawn" ||
      reg.status === "expired" ||
      reg.status === "rejected" ||
      reg.status === "waitlisted"
    ) {
      await tx`update registration_groups
               set payment_intent_id = coalesce(payment_intent_id, ${paymentIntentId}),
                   updated_at = now()
               where id = ${reg.group_id}`;
      if (!paymentIntentId && !reg.payment_intent_id) return null;
      return {
        kind: "late",
        reg,
        competitionId: div.competition_id,
        intent: (reg.payment_intent_id ?? paymentIntentId) as string,
      };
    }
    const settings = await loadSettings(tx, reg.division_id);
    // Finding #18b: charged_at is stamped HERE, unconditionally, before the
    // manual/auto approval fork below — the moment money actually lands for
    // this entry, regardless of whether materialise() ever runs for it.
    // `coalesce` makes it idempotent, the same convention entrant_id already
    // relies on being written exactly once.
    await tx`
      update registrations
      set status = 'paid',
          charged_at = coalesce(charged_at, now()),
          payment_intent_id = coalesce(payment_intent_id, ${paymentIntentId}),
          updated_at = now()
      where id = ${regId}`;
    // payment_intent_id lives on the cart now (V364).
    await tx`
      update registration_groups
      set payment_intent_id = coalesce(${paymentIntentId}, payment_intent_id),
          updated_at = now()
      where id = ${reg.group_id}`;
    // Lock the competition's fee rate on its FIRST paid entry (V312), from the
    // rate the PAID SESSION was billed at — not reg.fee_percent, which a later
    // re-mint overwrites, so paying a stale session after a plan change would
    // otherwise lock a rate no entrant was charged. reg.fee_percent is the
    // fallback only for sessions minted before the rate rode the metadata.
    // `is null` makes it first-wins and idempotent: a replay, or a second
    // concurrent payment, cannot move a rate already set. Offline entries carry
    // no rate and leave the competition unlocked for the first card payer.
    const lockRate = chargedFeePercent ?? reg.fee_percent;
    if (lockRate != null) {
      await tx`
        update competitions set fee_percent = ${lockRate}
         where id = ${div.competition_id} and fee_percent is null`;
    }
    // RULING B (RS002 W5 review): manual approval blocks the AUTOMATIC
    // confirmation a Stripe payment would otherwise trigger here — the
    // entry is already 'paid' (written above) and stays there for a human
    // to review via approveRegistration. Organiser-explicit paths
    // (confirmRegistration/markRegistrationPaidOffline/confirmRegistrationWaived)
    // are UNCHANGED by this ruling: an organiser clicking confirm IS the
    // approval decision. A dedicated one-column query rather than widening
    // `loadSettings`/`RegistrationSettingsRow` (this wave's ownership keeps
    // those export-only) — same "local superset, don't touch the shared
    // type" precedent as registration-submit.ts's SubmitSettingsRow and
    // registration-approval.ts's ApprovalSettingsRow.
    const [approvalRow] = await tx<{ approval: "auto" | "manual" }[]>`
      select approval from registration_settings where division_id = ${reg.division_id}`;
    if (approvalRow?.approval === "manual") {
      await audit(tx, div.competition_id, reg.org_id, "registration.paid_awaiting_approval", {
        registration_id: regId,
        amount_cents: reg.amount_cents,
      }, null);
      return {
        kind: "paid_awaiting_approval",
        divisionId: reg.division_id,
        competitionId: div.competition_id,
      };
    }
    const entrantId = await materialise(
      tx,
      { ...reg, status: "paid" },
      settings?.entrant_kind ?? "individual",
    );
    await audit(tx, div.competition_id, reg.org_id, "registration.confirmed", {
      registration_id: regId,
      entrant_id: entrantId,
      paid: true,
      amount_cents: reg.amount_cents,
    }, null);
    return {
      kind: "confirmed",
      divisionId: reg.division_id,
      competitionId: div.competition_id,
      orgId: reg.org_id,
      entrantId,
    };
  })) as unknown as PayOutcome;

  if (!outcome) return;
  if (outcome.kind === "paid_awaiting_approval") {
    // Public status page changed (pending -> paid), so still revalidate —
    // but no growth-loop earn grant: money moved, but nothing is confirmed
    // yet, and a manual reviewer can still reject it next.
    fireDivisionRevalidate(outcome.divisionId, outcome.competitionId);
    return;
  }
  if (outcome.kind === "confirmed") {
    log.info(
      { registrationId: regId, orgId: outcome.orgId, divisionId: outcome.divisionId },
      "registration: checkout confirmed",
    );
    fireDivisionRevalidate(outcome.divisionId, outcome.competitionId);
    // RS008: fire-and-forget, strictly AFTER the transaction above has
    // committed — see confirmRegistration's identical wiring for why.
    // Guarded, not merely typed: a solo sign-up confirms with no entrant of
    // its own, and there is no roster on it to invite.
    if (outcome.entrantId) void inviteUnclaimedMembers(outcome.orgId, outcome.entrantId);
    // Growth loop (SPEC-5 §2 C): the organiser's FIRST competition to take a paid
    // registration earns free AI credits. Fires only on a genuine first-time paid
    // CONFIRMATION (not a replay, a double-pay duplicate, or a late payment to a
    // withdrawn/expired reg that gets refunded), so the org's once-per-earn grant
    // is never spent on a payment that bounced back. Keyed once-per-ORG
    // (`earn:first_paid:${orgId}`) — every later paid registration no-ops on the
    // idempotency key. Best-effort (tryEarnGrant never throws) so a grant hiccup
    // never blocks the webhook ACK; orgId is the ORGANISER (reg.org_id mirrors the
    // division's/competition's org), not the registrant.
    await tryEarnGrant(outcome.orgId, "first_paid", FIRST_PAID_EARN);
    return;
  }
  // Refunds happen OUTSIDE the tx (network). A failure surfaces on the
  // organiser console via the audit trail, never blocks the webhook ACK.
  try {
    // RS002 (V368): refund exactly THIS entry's own charged amount, never the
    // cart's whole remaining balance — a sibling entry's money must never
    // move on a late/duplicate refund for this one (block comment above
    // RegistrationWithGroupRow, hazard 1).
    const entryRefundCents = outcome.reg.amount_cents;
    // Webhook redelivery guard (review fixup): Stripe delivers "at least
    // once", so the SAME stale checkout session can complete more than once
    // for a withdrawn/expired registration. withdrawCore avoids a double
    // refund by flipping status inside the locked tx before its refund
    // block; this path enters ALREADY withdrawn/expired, so it checks the
    // entry's own refunded_cents instead — a redelivery is then a silent
    // no-op rather than a second real Stripe refund (nothing enforced that
    // before; relying on Stripe to reject an over-refund is not guaranteed
    // once a partial refund or dispute has left headroom on the intent).
    if (outcome.kind === "late" && outcome.reg.refunded_cents >= outcome.reg.amount_cents) {
      return;
    }
    // Read BEFORE the money moves: a failure here lands in `refund_failed` with nothing refunded, which is true, where the same failure
    // after the Stripe call would report a refund failure for a refund that went through.
    const ctxRefund = await divisionCtx(sql, outcome.reg.division_id);
    const refund = await stripeRefund(outcome.intent, entryRefundCents);
    // ONE transaction records the refund and queues the registrant's receipt. A webhook leaves the first attempt to the worker (it has
    // no response of its own to defer behind). The duplicate path records no totals (the CONFIRMED payment is untouched), so its
    // transaction holds the receipt alone.
    await sql.begin(async (tx) => {
      if (outcome.kind === "late") {
        // Additive on BOTH tables (hazard 2 fixed), in ONE transaction (review
        // fixup — these were two separate autocommit statements; if the
        // second failed after the first committed, Stripe would already have
        // refunded the money while the entry and cart totals silently
        // diverged, and the whole attempt would still land in the catch below
        // as `refund_failed` — a misleading audit trail for a refund that
        // actually succeeded).
        await tx`
          update registrations
          set refunded_cents = refunded_cents + ${entryRefundCents}, updated_at = now()
          where id = ${outcome.reg.id}`;
        await tx`
          update registration_groups
          set refunded_cents = refunded_cents + ${entryRefundCents},
              refunded_at = now(), updated_at = now()
          where id = ${outcome.reg.group_id}`;
      }
      await queueRefundReceipt(tx, { reg: outcome.reg, ctx: ctxRefund, amountCents: entryRefundCents, refundId: refund.id });
    });
    await audit(sql, outcome.competitionId, outcome.reg.org_id, "registration.refunded", {
      registration_id: regId,
      amount_cents: outcome.reg.amount_cents,
      mode: outcome.kind === "late" ? "late_payment" : "duplicate",
      stripe_refund_id: refund.id,
    }, null);
  } catch (err) {
    await audit(sql, outcome.competitionId, outcome.reg.org_id, "registration.refund_failed", {
      registration_id: regId,
      mode: outcome.kind,
    }, null);
    await maybeAlertRegistrationRefundFailed({
      registrationId: regId,
      orgId: outcome.reg.org_id,
      competitionId: outcome.competitionId,
      amountCents: outcome.reg.amount_cents,
      currency: outcome.reg.currency,
      paymentIntentId: outcome.intent,
      reason: errText(err),
      mode: outcome.kind,
    });
  }
}

/**
 * Reconcile-on-return (billing.ts pattern): the status page calls this so a
 * paid registration confirms even when the webhook is delayed or missing
 * (local dev). Best-effort; never throws.
 */
export async function reconcileRegistration(regId: string, token: string): Promise<boolean> {
  try {
    // access_token_hash/checkout_session_id live on the cart now (V364).
    const [reg] = await sql<{ status: string; checkout_session_id: string | null }[]>`
      select r.status, g.checkout_session_id
      from registrations r join registration_groups g on g.id = r.group_id
      where r.id = ${regId} and g.access_token_hash = ${hashRegistrationToken(token)}`;
    if (!reg || reg.status !== "pending" || !reg.checkout_session_id) return false;
    const session = await getStripe().checkout.sessions.retrieve(reg.checkout_session_id);
    if (session.payment_status !== "paid") return false;
    // Re-keyed to the GROUP (W3b): the session may cover a whole cart now —
    // membership in registration_ids, not equality on the old singular key.
    if (!checkoutRegistrationIds(session).includes(regId)) return false;
    await handleRegistrationCheckoutCompleted(session);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reconcile-on-return for the token-free /r/[ref] flow (email-minted sessions,
 * spec T6): the session's own metadata must point at the ref's registration —
 * the ref is a lookup, the session is the proof. Best-effort; never throws.
 *
 * Security fix: `sessionId` is attacker-controlled (an unauthenticated,
 * `force-dynamic` GET query param on a public page) — the old code called
 * `sessions.retrieve(sessionId)` on that raw value before any binding check,
 * so anyone holding a ref whose oldest entry is `pending` could loop
 * `GET /r/{ref}?session_id=cs_test_anything` and drive one real Stripe API
 * call per request, billed to the PLATFORM account and counting against its
 * rate limits. Fixed by comparing the supplied id against
 * `registration_groups.checkout_session_id` — the session THIS cart's own
 * mint actually stamped — BEFORE calling Stripe at all. An id that isn't the
 * cart's current session now never reaches `sessions.retrieve`; the
 * `payment_status`/`registration_ids` checks below are unchanged for the one
 * id that does match.
 *
 * Known trade-off, accepted: if a NEWER session has since superseded the
 * stored id (a later re-mint), an older-but-legitimate `session_id` from
 * Stripe's own success redirect no longer reconciles here. The webhook
 * remains the primary fulfilment path and still covers it — do not add a
 * fallback that re-introduces the arbitrary retrieve to recover this case.
 */
export async function reconcileRegistrationBySession(
  ref: string,
  sessionId: string,
): Promise<boolean> {
  try {
    const reg = await regByRef(ref);
    if (reg.status !== "pending") return false;
    if (sessionId !== reg.checkout_session_id) return false;
    const session = await getStripe().checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== "paid") return false;
    // Re-keyed to the GROUP (W3b): the session may cover a whole cart now —
    // membership in registration_ids, not equality on the old singular key.
    if (!checkoutRegistrationIds(session).includes(reg.id)) return false;
    await handleRegistrationCheckoutCompleted(session);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reconcile-on-return for the rid+token status page (RS007) — the group-id
 * sibling of `reconcileRegistrationBySession` above. That function resolves
 * its group via `ref_code`, which is nullable (a submit whose ref-mint
 * retries were exhausted still commits the cart) — exactly the case
 * `groupById`'s own doc comment says THIS page exists to still serve, so
 * reconciling here cannot depend on a ref existing either. Keyed on the
 * group's DB id + the emailed access token instead, matching `groupById`'s
 * own lookup exactly.
 *
 * Same security posture as the ref-based sibling: the caller-supplied
 * `sessionId` is compared against the group's OWN stored
 * `checkout_session_id` BEFORE any Stripe call, closing the identical
 * arbitrary-retrieve hole that function's doc comment describes.
 *
 * Deliberately has NO "is some representative entry still pending" pre-check
 * — `handleRegistrationCheckoutCompleted` already re-derives everything from
 * the session's own `registration_ids` metadata and confirms each named
 * entry independently (`confirmPaidRegistration`'s own row-locked status
 * check), so such a gate would only be an optimisation, and the wrong one
 * for a multi-entry cart: a promotion mints a checkout for a SINGLE entry
 * (V378), so picking one arbitrary sibling to gate on could refuse to even
 * look at Stripe for a session that is genuinely paid. Best-effort; never
 * throws.
 *
 * RS007 follow-up: this is the ONLY reconcile path with no self-limit at
 * all — `reconcileRegistration`/`reconcileRegistrationBySession` both gate
 * on `status !== "pending"` before ever calling Stripe, but that exact gate
 * is wrong HERE (see the paragraph above), so this is rate-limited instead,
 * keyed on the group. The status page calls this on every qualifying GET
 * (`?checkout=success&session_id=...`), and that URL sits in browser
 * history and referrers — without a limiter, one repeat visit (or a leaked
 * link) is unbounded outbound amplification, one `checkout.sessions.retrieve`
 * per hit, against the platform's own Stripe read limit. A throttled call
 * folds into the same `false` every other early-return here already means
 * ("could not reconcile just now") — the caller discards the return value
 * either way and simply falls through to reading the group's current DB
 * state, so this never surfaces to the registrant.
 */
export async function reconcileRegistrationGroupBySession(
  groupId: string,
  token: string,
  sessionId: string,
): Promise<boolean> {
  try {
    if (!GROUP_ID_RE.test(groupId)) return false;
    await rateLimit(`reg-reconcile:${groupId}`, { max: 5, windowSeconds: 60 });
    const [group] = await sql<
      Pick<RegistrationGroupRow, "access_token_hash" | "checkout_session_id">[]
    >`
      select access_token_hash, checkout_session_id
      from registration_groups where id = ${groupId}`;
    if (!group || !tokenMatchesHash(token, group.access_token_hash)) return false;
    if (sessionId !== group.checkout_session_id) return false;
    const session = await getStripe().checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== "paid") return false;
    await handleRegistrationCheckoutCompleted(session);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reconcile-on-return for the player payment page (plan 2026-11-11-player-payment-page, Task 3): Stripe sends the player back to
 * `/r/pay/<token>?…&session_id=…`, and this confirms the entry when the webhook is late. Keyed on the ENTRY (the page resolves its
 * token to one), and the caller's `sessionId` is compared to that entry's own stored `pay_session_id` BEFORE any Stripe call - an
 * old tab or a forged query never reaches `sessions.retrieve` (the same posture as the two siblings above). Rate-limited per entry
 * like the group sibling, because the page has no `pending` gate of its own to stop a reload loop. Best-effort; never throws.
 */
export async function reconcileRegistrationByPaySession(registrationId: string, sessionId: string): Promise<boolean> {
  try {
    if (!GROUP_ID_RE.test(registrationId)) return false; // a uuid, like a group id
    await rateLimit(`reg-pay-reconcile:${registrationId}`, { max: 5, windowSeconds: 60 });
    const [reg] = await sql<{ pay_session_id: string | null }[]>`
      select pay_session_id from registrations where id = ${registrationId}`;
    if (!reg?.pay_session_id || sessionId !== reg.pay_session_id) return false;
    const session = await getStripe().checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== "paid") return false;
    if (!checkoutRegistrationIds(session).includes(registrationId)) return false;
    await handleRegistrationCheckoutCompleted(session);
    return true;
  } catch {
    return false;
  }
}
