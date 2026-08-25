import "server-only";
// RS002 W5 — approval transitions: approveRegistration, rejectRegistration,
// withdrawRegistration, promoteFromWaitlist. Design of record:
// docs/superpowers/specs/2026-08-16-registration-redesign-design.md §3
// (approval), owner ruling 6 ("Approval: per-division auto (default) |
// manual; new terminal status rejected").
//
// Module topology (RS002 `_INDEX.md`, kept on purpose): this file imports
// from `registrations.ts` only. Never add an edge back — that is the cycle
// the three-way split (`registration-eligibility.ts` / `registration-
// submit.ts` / this file) exists to avoid.
import type postgres from "postgres";
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { log } from "@/server/logger";
import type { AuthCtx } from "@/server/api-v1/auth";
import { fireDivisionRevalidate } from "@/server/public-site/revalidate";
import { assertNotFrozen, frozenCompetitionIds } from "./entitlement-freeze";
import {
  SPOT_HOLDERS,
  materialise,
  loadSettings,
  orgReg,
  orgRegAfter,
  audit,
  divisionCtx,
  notifyPromoted,
  fallbackOrigin,
  promoteOldestWaitlisted,
  promoteWaitlistedRow,
  withdrawRegistrationOrganiser,
  clearExpiresIfNoLongerNeeded,
  stripeRefund,
  notifyRefund,
  type RegistrationWithGroupRow,
  type RegistrationSettingsRow,
} from "./registrations";

type Tx = postgres.TransactionSql;

// ---------------------------------------------------------------------------
// Manual-approval settings read
// ---------------------------------------------------------------------------

/**
 * Bare `extends`, no redeclared field — `approval` now lives on the base
 * `RegistrationSettingsRow` itself (registrations.ts, RS004 wave 1's
 * SETTINGS_COLS extension), so retyping it here would only add a hazard: a
 * redeclared literal union does NOT inherit a future widening of the base
 * (RS004 review finding 3). Still kept as its own name, same precedent as
 * `registration-submit.ts`'s `SubmitSettingsRow` — this wave's file
 * ownership still keeps `registrations.ts`'s shared
 * `SETTINGS_COLS`/`RegistrationSettingsRow` to export-only edits, and
 * `loadApprovalSettings` below hand-writes its own SELECT instead of
 * calling the shared `loadSettings`. An alias, not a subtype, so it stays assignable to
 * `RegistrationSettingsRow` wherever `promoteOldestWaitlisted`/
 * `promoteWaitlistedRow` expect the base shape.
 */
type ApprovalSettingsRow = RegistrationSettingsRow;

// Exported for its own DB-backed test (finding 5: the hand-written SELECT
// below omitted allow_free_agents even though ApprovalSettingsRow requires
// it) — otherwise a private helper, called only from this file.
export async function loadApprovalSettings(tx: Tx, divisionId: string): Promise<ApprovalSettingsRow | null> {
  const [row] = await tx<ApprovalSettingsRow[]>`
    select division_id, enabled, entrant_kind, opens_at, closes_at, capacity,
           fee_cents, refund_lock_at, form_fields, payment_method,
           payment_instructions, updated_at, approval, allow_free_agents
    from registration_settings where division_id = ${divisionId}`;
  return row ?? null;
}

async function divisionCompetitionId(tx: Tx, divisionId: string): Promise<string> {
  const [div] = await tx<{ competition_id: string }[]>`
    select competition_id from divisions where id = ${divisionId}`;
  if (!div) throw new HttpError(404, "division not found");
  return div.competition_id;
}

// ---------------------------------------------------------------------------
// approveRegistration / rejectRegistration
// ---------------------------------------------------------------------------

/**
 * Manual-approval review: `pending`|`paid` → `confirmed`, materialising an
 * entrant exactly as `confirmRegistration` does (reused verbatim — never
 * reimplemented, per the wave-5 brief). Refused outright on an `auto`
 * division: that mode already auto-confirms free entries at submit
 * (`submitRegistrationGroup`) and paid ones on the webhook
 * (`confirmPaidRegistration`), so there is nothing for a manual review step
 * to do there. `rejected` is TERMINAL — approving after a reject always
 * fails, checked before anything else so it holds regardless of the
 * division's current approval mode. Idempotent: already-`confirmed` is a
 * silent no-op, not a second materialise. Also refused: an already-refunded
 * row (whole-branch review MAJOR) — `refundRegistration` does not itself
 * change `status`, so a `paid` row an organiser refunded through the normal
 * refund flow was otherwise still approvable, materialising a free entrant
 * for money that had already gone back.
 */
export async function approveRegistration(
  auth: AuthCtx,
  regId: string,
): Promise<RegistrationWithGroupRow> {
  // Resolved BEFORE the transaction — same reason confirmRegistration does:
  // `frozenCompetitionIds` queries the pooled `sql` proxy, and issuing that
  // from inside a `withTenant` callback that already pins a connection is
  // the self-deadlock class documented on entitlement-freeze.ts.
  const frozen = await frozenCompetitionIds(auth.orgId);
  const row = await withTenant(auth.orgId, async (tx) => {
    const reg = await orgReg(tx, regId);
    if (reg.status === "confirmed") return reg; // idempotent success
    if (reg.status === "rejected") {
      throw new HttpError(422, "This registration was rejected and cannot be approved");
    }
    if (reg.status !== "pending" && reg.status !== "paid") {
      throw new HttpError(422, `Cannot approve a ${reg.status} registration`);
    }
    // Whole-branch review MAJOR: refundRegistration does NOT change status,
    // so a 'paid' row an organiser already refunded stayed approvable —
    // checked here, off `reg` directly, before anything settings-dependent.
    if (reg.refunded_cents > 0) {
      throw new HttpError(422, "This registration was already refunded and cannot be approved");
    }
    const settings = await loadApprovalSettings(tx, reg.division_id);
    if (settings?.approval !== "manual") {
      throw new HttpError(422, "This division uses automatic approval — there is nothing to approve manually");
    }
    if ((settings.fee_cents ?? 0) > 0 && reg.status !== "paid" && reg.payment_intent_id === null) {
      throw new HttpError(
        422,
        "Awaiting payment — mark it paid first, or approve once payment arrives",
      );
    }
    const competitionId = await divisionCompetitionId(tx, reg.division_id);
    assertNotFrozen(frozen, competitionId);
    await materialise(tx, reg, settings.entrant_kind);
    await audit(tx, competitionId, auth.orgId, "registration.approved", {
      registration_id: regId,
      paid: reg.status === "paid",
    }, auth.userId);
    return orgRegAfter(tx, regId);
  });
  fireDivisionRevalidate(row.division_id);
  log.info(
    { event: "registration.approved", registration_id: regId, org_id: auth.orgId, status: row.status },
    "registration approved",
  );
  return row;
}

/**
 * Manual-approval review: `pending`|`paid` → `rejected` (terminal — see
 * `approveRegistration`). Frees the spot exactly like a withdraw does
 * (`withdrawCore`'s own doc comment): a rejected entry no longer holds
 * capacity, so the oldest waitlisted entry auto-promotes in the SAME
 * transaction; the cart's shared `expires_at` also clears if this was the
 * cart's last `pending` entry (same `clearExpiresIfNoLongerNeeded` guard as
 * `withdrawCore`/`sweepRegistrations` — whole-branch review MAJOR: this had
 * the identical stale-deadline gap and is fixed here rather than left next
 * to two sibling fixes in the same session). Idempotent: rejecting an
 * already-`rejected` row is a silent no-op — "not a second transition"
 * (wave-5 acceptance) — so it audits and promotes only on the FIRST call.
 *
 * `paid` is accepted (whole-branch review MAJOR) because ruling B
 * (`confirmPaidRegistration`, registrations.ts) can leave a Stripe-paid
 * manual-approval entry sitting at exactly `paid` awaiting review — before
 * this, that state could be APPROVED but never DECLINED, the precise gap
 * ruling B was invented to avoid. Rejecting a paid entry refunds it in the
 * same call (not the same SQL transaction — the Stripe network call happens
 * between two locked tx's, same two-phase pattern as
 * `withdrawCore`/`refundRegistration`: this entry's own remaining balance
 * only, never the cart's whole intent).
 */
export async function rejectRegistration(
  auth: AuthCtx,
  regId: string,
): Promise<RegistrationWithGroupRow> {
  const result = await withTenant(auth.orgId, async (tx) => {
    const reg = await orgReg(tx, regId);
    if (reg.status === "rejected") {
      return {
        row: reg,
        promoted: null as RegistrationWithGroupRow | null,
        competitionId: null as string | null,
        refundable: null as RegistrationWithGroupRow | null,
      };
    }
    if (reg.status !== "pending" && reg.status !== "paid") {
      throw new HttpError(422, `Cannot reject a ${reg.status} registration`);
    }
    const settings = await loadApprovalSettings(tx, reg.division_id);
    if (settings?.approval !== "manual") {
      throw new HttpError(422, "This division uses automatic approval — there is nothing to reject manually");
    }
    const competitionId = await divisionCompetitionId(tx, reg.division_id);
    await tx`
      update registrations set status = 'rejected', updated_at = now()
      where id = ${regId}`;
    await clearExpiresIfNoLongerNeeded(tx, reg.group_id, reg.id);
    const promoted = await promoteOldestWaitlisted(tx, reg.division_id, settings);
    await audit(tx, competitionId, auth.orgId, "registration.rejected", {
      registration_id: regId,
      paid: reg.status === "paid",
      promoted_registration_id: promoted?.id ?? null,
    }, auth.userId);
    if (promoted) {
      await audit(tx, competitionId, auth.orgId, "registration.promoted", {
        registration_id: promoted.id,
        from: "waitlist",
      }, auth.userId);
    }
    return {
      row: await orgRegAfter(tx, regId),
      promoted,
      competitionId,
      refundable: reg.status === "paid" ? reg : null,
    };
  });
  fireDivisionRevalidate(result.row.division_id, result.competitionId ?? undefined);
  if (result.promoted) {
    const ctx = await divisionCtx(sql, result.row.division_id);
    const settings = await loadSettings(sql, result.row.division_id);
    void notifyPromoted(result.promoted, ctx, settings, fallbackOrigin());
  }

  if (result.refundable?.payment_intent_id) {
    const remaining = result.refundable.amount_cents - result.refundable.refunded_cents;
    if (remaining > 0) {
      try {
        const refund = await stripeRefund(result.refundable.payment_intent_id, remaining);
        await sql.begin(async (tx) => {
          await tx`
            update registrations set refunded_cents = refunded_cents + ${remaining}, updated_at = now()
            where id = ${regId}`;
          await tx`
            update registration_groups
            set refunded_cents = refunded_cents + ${remaining}, refunded_at = now(), updated_at = now()
            where id = ${result.refundable!.group_id}`;
        });
        await audit(sql, result.competitionId!, auth.orgId, "registration.refunded", {
          registration_id: regId,
          amount_cents: remaining,
          mode: "reject",
          stripe_refund_id: refund.id,
        }, auth.userId);
        const refundCtx = await divisionCtx(sql, result.row.division_id);
        notifyRefund(result.refundable, refundCtx, remaining);
      } catch {
        // Same fail-open contract as withdrawCore: a refund failure must not
        // undo the reject decision — surfaces on the organiser console
        // (rejected + refunded_cents < amount_cents).
        await audit(sql, result.competitionId!, auth.orgId, "registration.refund_failed", {
          registration_id: regId,
          mode: "reject",
        }, auth.userId);
      }
    }
  }

  log.info(
    { event: "registration.rejected", registration_id: regId, org_id: auth.orgId, refunded: !!result.refundable },
    "registration rejected",
  );
  return result.row;
}

// ---------------------------------------------------------------------------
// withdrawRegistration
// ---------------------------------------------------------------------------

/**
 * Organiser withdraw, exposed from the approval-transitions module for API
 * symmetry with approve/reject/promote — "approval transitions" is meant as
 * the registration lifecycle's whole organiser-facing state-machine surface
 * (wave-5 brief). Delegates to the EXISTING `withdrawRegistrationOrganiser`
 * (registrations.ts) rather than reimplementing withdraw's refund-timing +
 * auto-promote + audit logic — that function is already correct, already
 * tested, and (via `withdrawCore` → `promoteOldestWaitlisted`) already
 * carries the SAME sibling-safe promotion fix this wave shipped. Idempotent:
 * `withdrawCore` no-ops on an already-`withdrawn` row.
 */
export async function withdrawRegistration(
  auth: AuthCtx,
  regId: string,
): Promise<RegistrationWithGroupRow> {
  const row = await withdrawRegistrationOrganiser(auth, regId);
  log.info(
    { event: "registration.withdraw_requested", registration_id: regId, org_id: auth.orgId, status: row.status },
    "registration withdraw requested",
  );
  return row;
}

// ---------------------------------------------------------------------------
// promoteFromWaitlist
// ---------------------------------------------------------------------------

export interface PromoteFromWaitlistOpts {
  /** Explicit-id override — promote THIS registration instead of the oldest
   *  waitlisted one. Must be `waitlisted` and belong to `divisionId`. */
  registrationId?: string;
}

/**
 * Organiser-triggered promotion: oldest-first by default
 * (`promoteOldestWaitlisted`), or a specific entry via
 * `opts.registrationId`. Both paths share `promoteWaitlistedRow`
 * (registrations.ts) — the routed wave-4 fix that scopes the cart-level
 * `payment_method`/`expires_at` write so it cannot clobber a sibling entry
 * still `pending` in the same cart (see the block comment on
 * `promoteWaitlistedRow`). No capacity re-check here, matching
 * `promoteOldestWaitlisted`'s existing contract elsewhere (sweep, withdraw):
 * promotion is a deliberate act by whoever calls it, not itself
 * capacity-gated. Idempotent for the explicit-id path: a row that ALREADY
 * holds (or held and moved past) a spot — `SPOT_HOLDERS` — is a no-op return
 * of its current state, not an error; only a genuinely dead entry
 * (withdrawn/expired/rejected) refuses. Returns `null` for the oldest-first
 * path when nothing is waitlisted.
 */
export async function promoteFromWaitlist(
  auth: AuthCtx,
  divisionId: string,
  opts: PromoteFromWaitlistOpts = {},
): Promise<RegistrationWithGroupRow | null> {
  const result = await withTenant(auth.orgId, async (tx) => {
    const competitionId = await divisionCompetitionId(tx, divisionId);
    const settings = await loadSettings(tx, divisionId);

    let promoted: RegistrationWithGroupRow | null;
    let alreadySettled = false;
    if (opts.registrationId) {
      const [target] = await tx<{ id: string; division_id: string; status: string; group_id: string }[]>`
        select id, division_id, status, group_id from registrations
        where id = ${opts.registrationId} for update`;
      if (!target || target.division_id !== divisionId) {
        throw new HttpError(404, "registration not found");
      }
      if ((SPOT_HOLDERS as readonly string[]).includes(target.status)) {
        promoted = await orgRegAfter(tx, target.id);
        alreadySettled = true;
      } else if (target.status !== "waitlisted") {
        throw new HttpError(422, `Cannot promote a ${target.status} registration`);
      } else {
        promoted = await promoteWaitlistedRow(tx, target.id, target.group_id, settings);
      }
    } else {
      promoted = await promoteOldestWaitlisted(tx, divisionId, settings);
    }

    if (promoted && !alreadySettled) {
      await audit(tx, competitionId, auth.orgId, "registration.promoted", {
        registration_id: promoted.id,
        from: "waitlist",
        by: "organiser",
      }, auth.userId);
    }
    return { promoted, competitionId, settings, freshlyPromoted: !!promoted && !alreadySettled };
  });

  if (!result.promoted) return null;
  fireDivisionRevalidate(divisionId, result.competitionId);
  if (result.freshlyPromoted) {
    const ctx = await divisionCtx(sql, divisionId);
    void notifyPromoted(result.promoted, ctx, result.settings, fallbackOrigin());
  }
  log.info(
    {
      event: "registration.promoted",
      registration_id: result.promoted.id,
      division_id: divisionId,
      org_id: auth.orgId,
      explicit: !!opts.registrationId,
    },
    "registration promoted from waitlist",
  );
  return result.promoted;
}
