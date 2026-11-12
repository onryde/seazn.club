import "server-only";
// Withdrawal core shared by the public and organiser paths, and the solo placement release (see ./index.ts).
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { deferred } from "@/lib/deferred";
import { dispatchNow } from "@/server/email-outbox";
import { resolveVenueTz } from "@/lib/tz";
import { log } from "@/server/logger";
import { fireDivisionRevalidate } from "@/server/public-site/revalidate";
// The entrant status flip inside `withdrawCore` is raw SQL, so `patchEntrant`'s
// own hook cannot fire — this is what refreshes a seeding draft that still
// names the registrant (review finding F3).
import { markFieldChangeSeedProposalsStale } from "../stages";
import { audit } from "../audit";
import type { Tx, RegistrationWithGroupRow } from "./types";
import { regGroupCols, loadSettings, divisionCtx, fallbackOrigin } from "./lookups";
import { clearExpiresIfNoLongerNeeded } from "./materialise";
import { queueRegistrationWithdrawnMails } from "./lifecycle-mail";
import { freesTeamSlot, promoteOldestWaitlisted, openPromotionSeatGate, notifyPromoted } from "./waitlist";
import {
  stripeRefund,
  queueRefundReceipt,
  errText,
  maybeAlertRegistrationRefundFailed,
  resolveRefundPolicy,
} from "./refunds";

/**
 * Release a solo sign-up's placement on someone else's team, if they have
 * one. Returns the team registration they were removed from, or null when
 * they were never placed (the ordinary case, and a cheap no-op).
 *
 * RS009. This exists because a placement survives every TERMINAL TRANSITION
 * unless something removes it: withdraw, reject and expire are all status
 * changes, and V388's `on delete cascade` only fires on a DELETE. Without
 * this, a placed solo sign-up who cancels from their status page is refunded
 * and still fielded — their roster row and their `entrant_members` row both
 * survive, the team still reads full, and nobody is told.
 *
 * ONE helper with three callers rather than three copies of the same two
 * deletes: `withdrawCore`, `rejectRegistration` and the expiry sweep. A
 * fourth terminal path added later needs to call this, and the shared name is
 * the only thing that will make that obvious.
 *
 * Order matters: the membership first, then the roster row. The reverse
 * leaves a person on the entrant with nothing left pointing at why they are
 * there — an orphan no cascade can reach, because the FK cascades from the
 * registration, not from this row.
 *
 * NO FIXTURES GUARD HERE, AND THAT ASYMMETRY WITH `unassignSoloSignUp` IS
 * DELIBERATE. Raised in review as a gap; it is not one, and the reasoning is
 * recorded so nobody "fixes" it into a match.
 *
 * `unassignSoloSignUp` refuses once the division has fixtures because that is
 * the ORGANISER reshuffling a roster mid-competition, which RS009's brief
 * explicitly rules is scheduling's territory. The callers here are something
 * else: a registrant withdrawing (their own right, exercised from the public
 * status page and already refunded by the time we get here), an organiser
 * rejecting, or the entry expiring unpaid. Refusing THOSE to protect a team
 * sheet would trap a person in a competition they have left — a far worse
 * outcome than the roster changing.
 *
 * It is also safe in the way the review feared it was not: a fixture
 * references `home_entrant_id`/`away_entrant_id`, i.e. the TEAM, never a
 * person. Removing one `entrant_members` row orphans no fixture and rewrites
 * no result; it changes who is on the team sheet from now on, which is the
 * true statement once somebody has withdrawn.
 *
 * The residual worth naming: this happens SILENTLY — the captain loses a
 * player and nobody is told. That is a notification gap, not a correctness
 * one, and it belongs with RS012's pool-promises work rather than here.
 */
export async function releaseSoloSignUpPlacement(
  tx: Tx,
  registrationId: string,
): Promise<string | null> {
  // BOTH directions, because a registration can be either end of a
  // placement:
  //
  //  - as the SOURCE, it is the solo sign-up who was placed somewhere;
  //  - as the TARGET, it is a team other solo sign-ups were placed ONTO.
  //
  // The first version handled only the source side, so withdrawing a TEAM
  // released none of the players borrowed onto it: their roster rows
  // survived pointing at a withdrawn entrant, and because they still read as
  // "already placed" the organiser could not re-assign them anywhere either.
  // A team pulling out has to put its borrowed players back in the pool.
  const placements = await tx<
    { id: string; registration_id: string; person_id: string | null }[]
  >`
    select id, registration_id, person_id from registration_players
    where assigned_from_registration_id = ${registrationId}
       or (registration_id = ${registrationId} and source = 'organiser_assigned')`;
  if (placements.length === 0) return null;

  let releasedFrom: string | null = null;
  for (const placement of placements) {
    const [target] = await tx<{ entrant_id: string | null }[]>`
      select entrant_id from registrations where id = ${placement.registration_id} for update`;
    if (target?.entrant_id && placement.person_id) {
      await tx`
        delete from entrant_members
        where entrant_id = ${target.entrant_id} and person_id = ${placement.person_id}`;
    }
    await tx`delete from registration_players where id = ${placement.id}`;
    // The source-side answer is the interesting one for the audit trail —
    // "this person came off that team". A target-side release removes
    // several at once and has no single such answer.
    if (placement.registration_id !== registrationId) releasedFrom = placement.registration_id;
  }
  return releasedFrom;
}

/** WHO withdrew is an explicit fact, never inferred from `actorId`: an organiser acting through an API key has NO user id (api-v1/auth.ts),
 *  and reading that as "the registrant" sent no mail and labelled the audit row wrongly. `actorId` is only the audit's actor column. */
export type WithdrawnBy = "organiser" | "registrant";

export async function withdrawCore(reg: RegistrationWithGroupRow, actorId: string | null, by: WithdrawnBy): Promise<void> {
  if (reg.status === "withdrawn") return; // idempotent
  // RULING A (RS002 W5 review, MAJOR): rejected is terminal from every
  // writer — reachable here from BOTH withdrawRegistrationOrganiser and the
  // public token-only withdrawRegistrationByRef. Without this, a rejected
  // row silently flipped to 'withdrawn' (the only special case this
  // function checked), which could also wrongly auto-promote a waitlisted
  // sibling for a spot the organiser had already closed. Fast-path check
  // (the pre-lock snapshot) mirrors the withdrawn idempotent check above;
  // the authoritative one is inside the tx, against the LOCKED row, below.
  if (reg.status === "rejected") {
    throw new HttpError(422, "This registration was rejected and cannot be withdrawn");
  }
  const settings = await loadSettings(sql, reg.division_id);
  const ctx = await divisionCtx(sql, reg.division_id);
  // The spot this frees goes to the waitlist, and where that seats the next registrant at once the seat gate decides who
  // (`promoteOldestWaitlisted`). Opened out here, before the transaction.
  const seatGate = await openPromotionSeatGate(reg.division_id, settings);

  const outcome = (await sql.begin(async (tx) => {
    if (seatGate) await seatGate.load(tx); // a superuser transaction: the link read needs no prelude
    // `for update` on the join locks both the entry AND its cart row — right
    // here, since the refund block below reads the cart's payment_intent_id.
    const [locked] = await tx<RegistrationWithGroupRow[]>`
      select ${regGroupCols(tx)}
      from registrations r join registration_groups g on g.id = r.group_id
      where r.id = ${reg.id} for update`;
    if (!locked || locked.status === "withdrawn") return null;
    if (locked.status === "rejected") {
      throw new HttpError(422, "This registration was rejected and cannot be withdrawn");
    }
    const freedSpot = freesTeamSlot(locked);
    await tx`
      update registrations
      set status = 'withdrawn', withdrawn_at = now(), updated_at = now()
      where id = ${reg.id}`;
    // A withdrawn entrant that was already materialised marks withdrawn too —
    // fixtures/standings handle entrant withdrawal by the existing rules.
    if (locked.entrant_id) {
      await tx`update entrants set status = 'withdrawn' where id = ${locked.entrant_id}`;
    }
    // RS009: if this entry is a solo sign-up placed on someone else's team,
    // withdrawing must take them OFF that roster. Marking their own entrant
    // withdrawn (above) does not touch it — that is a different entrant.
    const releasedFrom = await releaseSoloSignUpPlacement(tx, reg.id);
    // RS002 W5 whole-branch review MAJOR: withdrawing the cart's LAST
    // `pending` entry used to leave `registration_groups.expires_at` stale
    // forever — only `materialise`'s confirm path ever cleared it. Safe to
    // run unconditionally: this row is excluded from its own `not exists`
    // check regardless of what status it just left, and a cart with another
    // still-pending entry is correctly left untouched.
    await clearExpiresIfNoLongerNeeded(tx, locked.group_id, locked.id);
    const promoted = freedSpot
      ? await promoteOldestWaitlisted(tx, reg.division_id, settings, undefined, seatGate)
      : null;
    await audit(tx, ctx.competition_id, ctx.org_id, "registration.withdrawn", {
      registration_id: reg.id,
      by,
      promoted_registration_id: promoted?.id ?? null,
      released_from_registration_id: releasedFrom,
    }, actorId);
    if (promoted) {
      await audit(tx, ctx.competition_id, ctx.org_id, "registration.promoted", {
        registration_id: promoted.id,
        from: "waitlist",
      }, actorId);
    }
    // Polish wave P2 (W11): the ORGANISER's withdrawal is news to the registrant; their own is not (the status page and the reference page,
    // which refund and receipt on their own). Queued with the fact, so the two commit together.
    const mailIds = by === "organiser" ? await queueRegistrationWithdrawnMails(tx, { reg: locked }) : [];
    return { locked, promoted, mailIds };
  })) as unknown as
    | { locked: RegistrationWithGroupRow; promoted: RegistrationWithGroupRow | null; mailIds: string[] }
    | null;
  if (!outcome) return;
  log.info(
    { registrationId: reg.id, orgId: ctx.org_id, by },
    "registration: withdrawn",
  );

  // A registrant who cancels their own entry is a FIELD CHANGE, exactly like
  // an organiser's `PATCH /entrants/{id} {status:"withdrawn"}` — but the
  // entrant row above is flipped in raw SQL here, so `patchEntrant`'s own
  // hook never fires and nothing else would refresh a seeding draft that
  // still names them. Without this, the public self-cancel (the
  // highest-volume withdrawal there is) leaves the organiser looking at a
  // draft whose Confirm 422s and whose card has no Recompute — review
  // finding F3, 2026-09-21. patchEntrant is NOT the single status funnel.
  //
  // Only when an entrant was actually materialised: a pending/waitlisted
  // entry has no entrant row and cannot be in anybody's draft. Best-effort
  // and after the commit, same contract as patchEntrant's.
  if (outcome.locked.entrant_id) {
    try {
      await markFieldChangeSeedProposalsStale(ctx.org_id, reg.division_id);
    } catch {
      // best-effort: the withdrawal itself has committed, and
      // confirmSeedProposal refuses a departed qualifier regardless.
    }
  }

  fireDivisionRevalidate(reg.division_id, ctx.competition_id);
  const withdrawnMailIds = outcome.mailIds;
  if (withdrawnMailIds.length > 0) deferred(() => dispatchNow(withdrawnMailIds));
  if (outcome.promoted) {
    void notifyPromoted(outcome.promoted, ctx, settings, fallbackOrigin(), { firstAttempt: "request" });
  }

  // Auto-refund policy (doc 16 §1.1): full refund when withdrawal lands
  // before refund_lock_at (V379: or its starts_on fallback when unset — see
  // resolveRefundPolicy). After the lock it's organiser discretion via the
  // manual refund endpoint. Stripe call OUTSIDE the tx.
  const { locked } = outcome;
  const policy = resolveRefundPolicy(
    settings?.refund_lock_at ?? null,
    ctx.starts_on,
    resolveVenueTz(null, ctx.org_timezone),
    // REVIEW FIX (money-path defect #1, write-side twin of buildGroupStatusView's
    // fix above): `locked` is the pre-update row (read before the `status =
    // 'withdrawn'` write above), so `locked.status` is this entry's OWN status
    // right up to this withdrawal — 'pending'/'waitlisted' means it was never
    // itself charged, even when the CART's payment_intent_id is live from a
    // sibling's real payment. Passing the group PI unconditionally here used to
    // let cancelling a never-charged promoted sibling run a REAL stripeRefund
    // against the sibling's own money.
    // V387/H1: THIS ENTRY's own intent, and no fallback to the cart's. The
    // status gate above closes the never-charged sibling; it does NOT close
    // the case where both entries were genuinely charged in two different
    // sessions, because then the gate passes and the cart column holds the
    // OTHER entry's intent. Fail CLOSED when the entry has none recorded: a
    // null here makes `refundable` false, the registrant is told the refund
    // is at the organiser's discretion, and #16's manual refund control
    // handles it. Falling back to the cart's intent is precisely the
    // behaviour being removed — an automatic refund against a charge that
    // may not be this entry's.
    locked.status === "paid" || locked.status === "confirmed"
      ? locked.entry_payment_intent_id
      : null,
    locked.amount_cents,
    locked.refunded_cents,
  );
  if (policy.refundable) {
    // RS002 (V368): THIS entry's own remaining balance — never the cart's
    // whole intent (hazard 1) — so a sibling that already carries a partial
    // refund (organiser discretion, then a late withdrawal) is never
    // double-counted here either.
    const remaining = policy.amount_cents;
    try {
      // Same value the policy above was resolved from — never the cart's.
      const refund = await stripeRefund(locked.entry_payment_intent_id as string, remaining);
      // Additive on BOTH tables (hazard 2 fixed), in ONE transaction (review
      // fixup — matches refundRegistration's withTenant-wrapped pattern
      // below: two separate autocommit statements could leave the entry and
      // cart totals silently diverged if the second failed after the first
      // committed, reachable today on a single-entry cart, no multi-entry
      // cart needed).
      // The registrant's receipt is queued in the SAME transaction (`ctx` was read before it). This is a request: the first attempt is
      // made after the response, off the caller's path.
      const receiptId = await sql.begin(async (tx) => {
        await tx`
          update registrations
          set refunded_cents = refunded_cents + ${remaining}, updated_at = now()
          where id = ${locked.id}`;
        await tx`
          update registration_groups
          set refunded_cents = refunded_cents + ${remaining}, refunded_at = now(), updated_at = now()
          where id = ${locked.group_id}`;
        return queueRefundReceipt(tx, { reg: locked, ctx, amountCents: remaining, refundId: refund.id });
      });
      if (receiptId !== null) deferred(() => dispatchNow([receiptId]));
      await audit(sql, ctx.competition_id, ctx.org_id, "registration.refunded", {
        registration_id: reg.id,
        amount_cents: remaining,
        mode: "auto",
        stripe_refund_id: refund.id,
      }, actorId);
    } catch (err) {
      // Refund failure must not undo the withdrawal — surfaces on the
      // organiser console (withdrawn + refunded_cents < amount_cents).
      await audit(sql, ctx.competition_id, ctx.org_id, "registration.refund_failed", {
        registration_id: reg.id,
        mode: "auto",
      }, actorId);
      await maybeAlertRegistrationRefundFailed({
        registrationId: reg.id,
        orgId: ctx.org_id,
        competitionId: ctx.competition_id,
        amountCents: remaining,
        currency: locked.currency,
        paymentIntentId: locked.payment_intent_id,
        reason: errText(err),
        mode: "auto",
      });
    }
  }
}
