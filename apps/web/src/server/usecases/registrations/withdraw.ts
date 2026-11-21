import "server-only";
// Withdrawal core shared by the public and organiser paths, and the solo placement release (see ./index.ts).
import { sql } from "@/lib/db";
import { ownPaymentRefundedCents } from "@/lib/registration-status";
import { HttpError } from "@/lib/errors";
import { deferred } from "@/lib/deferred";
import { dispatchNow } from "@/server/email-outbox";
import { resolveVenueTz } from "@/lib/tz";
import { log } from "@/server/logger";
import { roundRobinRefusal } from "../roundrobin-refusal";
import { fireDivisionRevalidate } from "@/server/public-site/revalidate";
// The entrant status flip inside `withdrawCore` is raw SQL, so `patchEntrant`'s
// own hook cannot fire — this is what refreshes a seeding draft that still
// names the registrant (review finding F3).
import { divisionHasStarted, markFieldChangeSeedProposalsStale } from "../stages";
import { audit } from "../audit";
import type { Tx, RegistrationWithGroupRow } from "./types";
import { regGroupCols, loadSettings, divisionCtx, fallbackOrigin } from "./lookups";
import { clearExpiresIfNoLongerNeeded } from "./materialise";
import { queueRegistrationWithdrawnMails } from "./lifecycle-mail";
import { freesTeamSlot, promoteOldestWaitlisted, openPromotionSeatGate, notifyPromoted } from "./waitlist";
import { lockForPromotionCap, onlineCapHoldsPromotion, openOnlineCapGuard } from "@/server/external-play/online-entrant-cap";
import { refundEntryUnderLock, resolveRefundPolicy } from "./refunds";

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
  /** W5 T10 fix round 1 (R12): where a PAIR of a started division (any format, ruling 292) that loses this person is reported (its entrant id), for
   *  the caller to dissolve through the withdrawal cascade AFTER its transaction commits (the cascade is many transactions).
   *  A caller that passes none cannot run the cascade, so such a release is refused instead (`RR_SUBSTITUTE_PARTNER_REFUSED`). */
  pairLosses?: string[],
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
    const [target] = await tx<{ entrant_id: string | null; division_id: string }[]>`
      select entrant_id, division_id from registrations where id = ${placement.registration_id} for update`;
    if (target?.entrant_id && placement.person_id) {
      // W5 T10 fix round 1 (R12; RB5-R2): a placed solo who leaves is a partner LEAVING. On a pair of a started division (any format, ruling 292)
      // the member row is kept (the pair is the entrant; its record stands) and the pair withdraws instead - reported to the
      // caller, which runs the cascade after the commit. A departed pair's roster is frozen the same way (nothing to dissolve).
      const members = (await tx<{ person_id: string }[]>`select person_id from entrant_members where entrant_id = ${target.entrant_id}`)
        .map((m) => m.person_id)
        .filter((id) => id !== placement.person_id);
      // A dynamic import, as this file's other reads of entrants.ts: that module reaches the stages graph this one is imported from.
      const { pairRosterVerdictTx } = await import("../entrants");
      const verdict = await pairRosterVerdictTx(tx, target.entrant_id, members);
      if (verdict === "none") {
        await tx`
          delete from entrant_members
          where entrant_id = ${target.entrant_id} and person_id = ${placement.person_id}`;
      } else if (verdict === "dissolve") {
        if (pairLosses === undefined) throw roundRobinRefusal("RR_SUBSTITUTE_PARTNER_REFUSED");
        if (!pairLosses.includes(target.entrant_id)) {
          pairLosses.push(target.entrant_id);
          // I-1 (fix round 2): the dissolve runs after the commit and may fail; this row, written with the release, is what the
          // desk and the retries find the pair by once the placement row below is gone.
          const { recordPairDissolveOwed } = await import("../withdrawal");
          await recordPairDissolveOwed(tx, target.division_id, target.entrant_id, registrationId);
        }
      }
    }
    await tx`delete from registration_players where id = ${placement.id}`;
    // The source-side answer is the interesting one for the audit trail —
    // "this person came off that team". A target-side release removes
    // several at once and has no single such answer.
    if (placement.registration_id !== registrationId) releasedFrom = placement.registration_id;
  }
  return releasedFrom;
}

/**
 * W5 T8b (X-WDT-9; rulings 111, 288): the entrant of a registration withdrawn after Start leaves through the table withdrawal
 * (`withdrawEntrantCascade`) — the same rule an organiser's Withdraw applies, one door. It runs after the registration has
 * committed, under the org's own server authority (`cascadeAuthFor`: the registrant has no staff user), and its ledger rows
 * name the registrant (`actor`).
 *
 * A cascade that throws is logged and swallowed. The registration (and its refund, below) stands — telling the registrant it
 * failed would be false. The entrant is left IN THE FIELD (the cascade writes her status last, so a failure never leaves a
 * departed entrant over seated lines), which is the recoverable state: the organiser's Withdraw on the Entrants tab runs the
 * cascade again from the rows as they stand.
 */
async function settleStartedWithdrawal(
  orgId: string,
  registrationId: string,
  entrantId: string,
  by: WithdrawnBy,
  actorId: string | null,
): Promise<void> {
  const { cascadeAuthFor, withdrawEntrantCascade } = await import("../withdrawal");
  try {
    // An organiser's own withdrawal of the registration keeps the organiser on the events and the row (`actorId`, as their
    // Withdraw button does); the registrant's names no staff user.
    await withdrawEntrantCascade(cascadeAuthFor(orgId, by === "organiser" ? actorId : null), entrantId, {
      ...(by === "registrant" ? { actor: { kind: "registrant" as const, registration_id: registrationId } } : {}),
    });
  } catch (err) {
    // Re-review: a run that waited behind another (the cascade's lock) and found her already gone — done, nothing failed.
    const [now] = await sql<{ status: string }[]>`select status from entrants where id = ${entrantId}`;
    if (now !== undefined && (await import("../entrants")).DEPARTED_STATUSES.has(now.status)) return;
    log.error(
      { err, registrationId, entrantId, orgId },
      "registration: withdrawn after Start, but the table withdrawal failed — the entrant is still in the field; the organiser's Withdraw finishes it",
    );
  }
}

/**
 * W5 T10 fix round 1 (R12; RB5-R2): the pairs of a started division (any format, ruling 292) that a released solo placement left a partner short
 * (`releaseSoloSignUpPlacement`'s `pairLosses`) withdraw through the same cascade as any other withdrawal, once the releasing
 * transaction has committed. Failure handling is `settleStartedWithdrawal`'s: logged, the pair left in the field - and, I-1 (fix round 2),
 * SHOWN: the release wrote a durable `pair_dissolve_owed` row with it (`recordPairDissolveOwed`), so the desk's "withdrawal did
 * not finish" item names the pair, the solo's re-POST (`retryOwedWithdrawal`) retries it, and so does the organiser's Withdraw on
 * the pair (the same lock-guarded cascade). Shared by the withdrawal, a rejection and the expiry sweep.
 *
 * The expiry sweep's call of this is wired and UNTESTED: it cannot be reached today (assign refuses an unpaid solo and expiry
 * takes only `pending` ones, so a placed solo never expires) - m-1, accepted; the release it shares is covered by the other two.
 */
export async function dissolvePairsAfterRelease(
  orgId: string,
  registrationId: string,
  entrantIds: readonly string[],
  by: WithdrawnBy,
  actorId: string | null,
): Promise<void> {
  for (const entrantId of entrantIds) await settleStartedWithdrawal(orgId, registrationId, entrantId, by, actorId);
}

/**
 * W5 T8b review I2 (a): a withdrawal POSTed again (the registrant's retry, the organiser's) for a registration already
 * withdrawn after Start runs the table withdrawal its first attempt did not finish — the entrant still in the field, and not
 * reinstated since (`withdrawalOwedSince`). Re-review: no window — the cascade holds a per-entrant lock, so a double POST
 * racing the first run waits for it and then finds her gone. Anything else is the idempotent no-op it always was.
 */
async function retryOwedWithdrawal(regId: string, divisionId: string, actorId: string | null, by: WithdrawnBy): Promise<void> {
  const [{ withdrawalOwedSince }, { DEPARTED_STATUSES }] = await Promise.all([import("../withdrawal"), import("../entrants")]);
  const [row] = await sql<{ entrant_id: string; withdrawn_at: Date | null; entrant_status: string }[]>`
    select r.entrant_id, r.withdrawn_at, e.status as entrant_status
      from registrations r join entrants e on e.id = r.entrant_id
     where r.id = ${regId} and r.status = 'withdrawn'`;
  if (row !== undefined && row.withdrawn_at !== null && !DEPARTED_STATUSES.has(row.entrant_status)) {
    const at = row.withdrawn_at;
    const entrantId = row.entrant_id;
    // Started, and still owed (a Reinstate since her withdrawal stands: the organiser's last word).
    const owed = await sql.begin(async (tx) => (await divisionHasStarted(tx, divisionId)) && (await withdrawalOwedSince(tx, divisionId, entrantId, at)));
    if (owed) {
      const ctx = await divisionCtx(sql, divisionId);
      await settleStartedWithdrawal(ctx.org_id, regId, row.entrant_id, by, actorId);
    }
  }
  // Her own entrant's state is no bar to the pairs below (a placed solo has none, or it departed long ago).
  await retryOwedPairDissolves(regId, by, actorId);
}

/**
 * W5 T10 fix round 2 (I-1): the pairs a registration's release left a partner short whose dissolve did not finish (a
 * `pair_dissolve_owed` marker, the pair still in the field and not reinstated since) run the cascade again. Reached by the solo's
 * withdrawal POSTed again and by a rejection POSTed again; the organiser's Withdraw on the pair is the third door, the same
 * lock-guarded cascade. Nothing owed is the no-op it always was.
 */
export async function retryOwedPairDissolves(regId: string, by: WithdrawnBy, actorId: string | null): Promise<void> {
  const { owedPairsOfRegistration } = await import("../withdrawal");
  for (const pair of await sql.begin((tx) => owedPairsOfRegistration(tx, regId))) {
    const ctx = await divisionCtx(sql, pair.divisionId);
    await settleStartedWithdrawal(ctx.org_id, regId, pair.entrantId, by, actorId);
  }
}

/** WHO withdrew is an explicit fact, never inferred from `actorId`: an organiser acting through an API key has NO user id (api-v1/auth.ts),
 *  and reading that as "the registrant" sent no mail and labelled the audit row wrongly. `actorId` is only the audit's actor column. */
export type WithdrawnBy = "organiser" | "registrant";

export async function withdrawCore(reg: RegistrationWithGroupRow, actorId: string | null, by: WithdrawnBy): Promise<void> {
  if (reg.status === "withdrawn") return retryOwedWithdrawal(reg.id, reg.division_id, actorId, by); // idempotent, bar an owed cascade
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
  // Re-review N1: the same promotion asks the online cap whether a place is really free (an entitlement read, so out here as well).
  const capGuard = await openOnlineCapGuard(reg.division_id);

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
    // The division lock before any entrant row is written (registration row -> `division:` -> entrants, online-entrant-cap.ts).
    if (freedSpot) await lockForPromotionCap(tx, reg.division_id, capGuard);
    await tx`
      update registrations
      set status = 'withdrawn', withdrawn_at = now(), updated_at = now()
      where id = ${reg.id}`;
    // W5 T8b (X-WDT-9, ruling 111 joins the withdrawal door, ruling 288): once the division has started, the entrant leaves
    // through the table withdrawal — the cascade, after this commits (below), which writes her status LAST. Before Start it is
    // the bare flip it always was (the field regenerates). "Started" is the cascade's own predicate (`divisionHasStarted`, T9's
    // one reading, C17), read here under the registration's lock: were the two to disagree, a bare flip after Start would leave
    // her lines seated against a departed entrant.
    const cascadeOwed = locked.entrant_id !== null && (await divisionHasStarted(tx, reg.division_id));
    if (locked.entrant_id && !cascadeOwed) {
      // W5 T6 review m2: a player waiting for a table place (`table_waiting_stage_id`) stops waiting as they leave — this write
      // never reaches `writeEntrantPatch`, which clears it on every other departure.
      // B3 fix wave (I-2): never over a departure already written - a disqualified entrant stays disqualified (the first
      // departure governs, RB3-17); the registration itself still withdraws by its own rules above and below.
      const { DEPARTED_STATUSES } = await import("../entrants");
      await tx`update entrants set status = 'withdrawn', table_waiting_stage_id = null
                where id = ${locked.entrant_id} and status not in ${tx([...DEPARTED_STATUSES])}`;
    }
    // RS009: if this entry is a solo sign-up placed on someone else's team,
    // withdrawing must take them OFF that roster. Marking their own entrant
    // withdrawn (above) does not touch it — that is a different entrant.
    const pairLosses: string[] = [];
    const releasedFrom = await releaseSoloSignUpPlacement(tx, reg.id, pairLosses);
    // RS002 W5 whole-branch review MAJOR: withdrawing the cart's LAST
    // `pending` entry used to leave `registration_groups.expires_at` stale
    // forever — only `materialise`'s confirm path ever cleared it. Safe to
    // run unconditionally: this row is excluded from its own `not exists`
    // check regardless of what status it just left, and a cart with another
    // still-pending entry is correctly left untouched.
    await clearExpiresIfNoLongerNeeded(tx, locked.group_id, locked.id);
    // A registration that leaves is not always a place that frees: an organiser may have withdrawn its entrant from the table already
    // (and filled the place). An online division at its cap serves nobody from the waitlist (`onlineCapHoldsPromotion`) - except for
    // the place THIS withdrawal frees: after Start the entrant is still live until the table withdrawal below runs, so it is passed as
    // the one leaving (`cascadeOwed`), and counted out while it is live.
    const promoted =
      freedSpot && !(await onlineCapHoldsPromotion(tx, reg.division_id, capGuard, cascadeOwed ? locked.entrant_id : null))
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
    return { locked, promoted, mailIds, cascadeOwed, pairLosses };
  })) as unknown as
    | { locked: RegistrationWithGroupRow; promoted: RegistrationWithGroupRow | null; mailIds: string[]; cascadeOwed: boolean; pairLosses: string[] }
    | null;
  // Idempotent: only the call whose transaction moved the row to `withdrawn` (under its `for update`) gets here, so a double
  // POST or a retry runs no second cascade.
  if (!outcome) return retryOwedWithdrawal(reg.id, reg.division_id, actorId, by);
  log.info(
    { registrationId: reg.id, orgId: ctx.org_id, by },
    "registration: withdrawn",
  );

  if (outcome.cascadeOwed && outcome.locked.entrant_id) {
    await settleStartedWithdrawal(ctx.org_id, reg.id, outcome.locked.entrant_id, by, actorId);
  }
  // W5 T10 fix round 1 (R12): the pairs this placed solo's leaving left a partner short withdraw too (the entrant's own pair, when
  // she was a team's target, was settled just above).
  await dissolvePairsAfterRelease(ctx.org_id, reg.id, outcome.pairLosses.filter((e) => e !== outcome.locked.entrant_id), by, actorId);

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
    // Polish wave P5 (carry b): what was sent back of THIS payment, not the history (a late payment's refund is not this one's).
    ownPaymentRefundedCents(locked),
  );
  if (policy.refundable) {
    // RS002 (V368): THIS entry's own remaining balance - never the cart's whole intent (hazard 1). Final review m6: moved, capped
    // and booked under the entry's lock, with the shared key, so an organiser's Refund pressed during this call waits and reads
    // what it left instead of refunding the same money again. A failure is recorded and alerted there and never undoes the
    // withdrawal (it surfaces on the organiser console as withdrawn + refunded_cents < amount_cents).
    const refunded = await refundEntryUnderLock({
      regId: locked.id,
      ctx,
      capCents: policy.amount_cents,
      mode: "auto",
      actorId,
      currency: locked.currency,
    });
    // A request: the first attempt is made after the response, off the caller's path.
    if (refunded?.receiptId) {
      const receiptId = refunded.receiptId;
      deferred(() => dispatchNow([receiptId]));
    }
  }
}
