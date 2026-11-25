import "server-only";
import type postgres from "postgres";
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { assertWithinLimit, getLimit } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { expireCompetitionShell } from "@/server/public-site/revalidate";
import {
  applyPackageDelete, captureRefundEvents, packageRefundPreview, planPackageDelete, type PackageDeletePlan, type RefundedPackage,
} from "../online-package";
import { type DivisionRow, COLS } from "./types";
import { assertCompetitionNotEnded } from "./helpers";

// ---------------------------------------------------------------------------
// Delete / archive / restore — v3/09 §4 (PROMPT-38). Graduated
// destructiveness: setup divisions hard-delete; started/resulted divisions
// archive (hidden + restorable); archived divisions purge after a 30-day
// cool-off. Owner/admin only (the route enforces the role).
// ---------------------------------------------------------------------------

const PURGE_COOL_OFF_DAYS = 30;

interface DeleteTarget {
  id: string;
  competition_id: string;
  name: string;
  slug: string;
  sport_key: string;
  status: string;
  archived_at: string | null;
}

async function auditCompetition(
  tx: postgres.TransactionSql,
  competitionId: string,
  type: string,
  payload: Record<string, unknown>,
  actorId: string | null,
): Promise<void> {
  await tx`
    insert into competition_events (competition_id, type, payload, actor_id)
    values (${competitionId}, ${type}, ${tx.json(payload as never)}, ${actorId})`;
}

// Open registration blocks delete AND archive: registrants could still be
// paying into a division that is about to vanish (v3/09 §4).
async function assertRegistrationClosed(
  tx: postgres.TransactionSql,
  divisionId: string,
  action: "delete" | "archive",
): Promise<void> {
  const [settings] = await tx<{ enabled: boolean; closes_at: string | null }[]>`
    select enabled, closes_at from registration_settings where division_id = ${divisionId}`;
  const open =
    settings?.enabled === true &&
    (settings.closes_at === null || new Date(settings.closes_at).getTime() > Date.now());
  if (open) {
    throw new HttpError(
      409,
      `Registration is open for this division — close registration first, then ${action} it`,
      "REGISTRATION_OPEN",
    );
  }
}

/** Delete's refusal of a live (unarchived) division, DIVISION_HAS_RESULTS: it left setup or it recorded a result. ONE rule for
 *  the delete and for the danger zone's read of whether a delete would refund (`divisionPackageRefund`). */
function deleteRefusedForStart(status: string, hasResults: boolean): boolean {
  return status !== "setup" || hasResults;
}

/**
 * DELETE semantics: setup division (never started, nothing decided) → hard
 * delete; archived ≥30 days → purge (hard delete); anything else → 409
 * DIVISION_HAS_RESULTS with the `{archive: true}` hint. Frozen competitions
 * are NOT blocked: deleting reduces usage, which is the honest way out of an
 * over-quota freeze.
 */
export async function deleteDivision(auth: AuthCtx, id: string): Promise<void> {
  // Online Chess (spec 2026-11-23 §7.3): the division's package goes with it — paid and unfrozen is refunded in full, unpaid
  // is deleted, frozen is left. Planned in the privileged prelude, BEFORE the delete sets its `division_id` to null, under the
  // `division:` lock and the money lock; applied in the privileged epilogue by the ids read here, so the refund commits or
  // rolls back with the delete. Never flag-gated.
  let packages: PackageDeletePlan | null = null;
  // The packages the epilogue refunded, for the analytics sent after the commit (a fresh list per attempt).
  let refunded: RefundedPackage[] = [];
  const deleted = await withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<DeleteTarget[]>`
      select id, competition_id, name, slug, sport_key, status, archived_at
      from divisions where id = ${id}`;
    if (!division) throw new HttpError(404, "division not found");
    await assertRegistrationClosed(tx, id, "delete");

    // Money records must outlive mistakes (spec 2026-07-12 issue #10): a hard
    // delete cascades the registrations away, so block it while any card
    // payment on this division is not fully refunded. Archive stays open.
    // Polish wave P5 (carry d): per ENTRY - its own card payment (V387) net of
    // that payment's refunds (`ownPaymentRefundedCents`, V512). The cart's
    // totals never clear while it holds an unpaid entry beside a refunded one.
    const [{ live_payments }] = await tx<{ live_payments: number }[]>`
      select count(*)::int as live_payments from registrations r
      where r.division_id = ${id} and r.payment_intent_id is not null
        and r.refunded_cents - r.late_refunded_cents < r.amount_cents`;
    if (live_payments > 0) {
      throw new HttpError(
        409,
        "Registrations here hold card payments — refund them before deleting, or archive instead",
        "REGISTRATION_PAYMENTS",
        { archive: true },
      );
    }

    // ONE definition of "has recorded results", shared with the quota count in
    // createDivision (V354). The two ask different questions of it — delete
    // refuses, the quota charges — but they must never disagree about the
    // answer, and this repo's recurring defect is exactly a forked copy of one
    // rule. The audit payload keeps a real count, which is not the same
    // question and stays a count.
    const [{ has_results }] = await tx<{ has_results: boolean }[]>`
      select division_has_results(${id}) as has_results`;

    if (division.archived_at !== null) {
      // Purge path: archived divisions hard-delete after the cool-off.
      const ageMs = Date.now() - new Date(division.archived_at).getTime();
      const coolOffMs = PURGE_COOL_OFF_DAYS * 24 * 60 * 60 * 1000;
      if (ageMs < coolOffMs) {
        const daysLeft = Math.ceil((coolOffMs - ageMs) / (24 * 60 * 60 * 1000));
        throw new HttpError(
          409,
          `An archived division can be purged ${PURGE_COOL_OFF_DAYS} days after archiving — ${daysLeft} day(s) to go`,
          "ARCHIVE_COOL_OFF",
        );
      }
    } else if (deleteRefusedForStart(division.status, has_results)) {
      // Broader than the SLOT rule (V354) deliberately: this destroys data, so
      // a division that merely LEFT setup is protected too. The slot rule
      // charges only for real results, because publishing a misconfigured
      // division and archiving it is a mistake, not usage.
      throw new HttpError(
        409,
        "This division has started or has recorded results — archive it instead (restorable), or purge it 30 days after archiving",
        "DIVISION_HAS_RESULTS",
        { archive: true },
      );
    }

    const [{ entrants }] = await tx<{ entrants: number }[]>`
      select count(*)::int as entrants from entrants where division_id = ${id}`;
    const [{ fixtures }] = await tx<{ fixtures: number }[]>`
      select count(*)::int as fixtures from fixtures where division_id = ${id}`;
    // Audit fidelity, not a guard: how MANY results died with the row. The
    // guard's question ("any at all?") is division_has_results above — this is
    // a different question, so it stays a count.
    const [{ decided }] = await tx<{ decided: number }[]>`
      select count(*)::int as decided from fixtures
      where division_id = ${id} and status in ('decided', 'finalized', 'forfeited')`;

    // The division ledger dies with the row (ON DELETE CASCADE); the audit
    // fact lives on the competition ledger, which survives (v3/09 §4).
    // Persons/teams/clubs are org-level rows — untouched by design.
    await auditCompetition(
      tx,
      division.competition_id,
      division.archived_at !== null ? "division_purged" : "division_deleted",
      {
        division_id: id,
        name: division.name,
        slug: division.slug,
        sport_key: division.sport_key,
        entrants,
        fixtures,
        decided_fixtures: decided,
      },
      auth.userId,
    );
    await tx`delete from divisions where id = ${id}`;
    return division;
  }, {
    privilegedPrelude: async (ptx) => {
      packages = await planPackageDelete(ptx, { orgId: auth.orgId, divisionIds: [id] });
    },
    privilegedEpilogue: async (etx) => {
      refunded = [];
      await applyPackageDelete(etx, auth.orgId, packages!, refunded);
    },
  });
  await captureRefundEvents(refunded, { orgId: auth.orgId, actorId: auth.userId });
  // A purge removes a division the shell stopped listing when it was archived.
  if (deleted.archived_at === null) {
    await expireCompetitionShell(auth.orgId, { competitionId: deleted.competition_id, divisionId: id });
  }
}

/** The danger zone's Online Chess facts (spec §11, final review m2 + Q7): what a refund of the division's paid, unfrozen package
 *  gives back and gives up now (`packageRefundPreview`, the refund's own split), and whether a DELETE would take it — the division
 *  is live and still deletable by delete's own rule (`deleteRefusedForStart`). Once it has started, only switching Online Chess off
 *  refunds it: archive holds the package (§11 "Division archived"). A paid package a round has frozen is `{ frozen: true }`: no
 *  door refunds it (P7), and the dialogs say so (Task 15 fix round 2). Null when no money was paid (no package, unpaid).
 *  Read-only. */
export type DivisionPackageRefund = { back: number; forfeited: number; onDelete: boolean; frozen?: never } | { frozen: true };
export async function divisionPackageRefund(auth: AuthCtx, id: string): Promise<DivisionPackageRefund | null> {
  const refund = await packageRefundPreview(auth.orgId, id);
  if (refund === null || refund.frozen === true) return refund;
  const onDelete = await withTenant(auth.orgId, async (tx) => {
    const [d] = await tx<{ status: string; archived_at: string | null; has_results: boolean }[]>`
      select status, archived_at, division_has_results(id) as has_results from divisions where id = ${id}`;
    if (!d) throw new HttpError(404, "division not found");
    return d.archived_at === null && !deleteRefusedForStart(d.status, d.has_results);
  });
  return { ...refund, onDelete };
}

/** Archive: hide from console/public/quota, restorable. Idempotent. */
export async function archiveDivision(auth: AuthCtx, id: string): Promise<DivisionRow> {
  let archived = false;
  const result = await withTenant(auth.orgId, async (tx) => {
    archived = false;
    const [existing] = await tx<DivisionRow[]>`
      select ${tx(COLS)} from divisions where id = ${id}`;
    if (!existing) throw new HttpError(404, "division not found");
    if (existing.archived_at !== null) return existing;
    await assertRegistrationClosed(tx, id, "archive");

    const [row] = await tx<DivisionRow[]>`
      update divisions set archived_at = now() where id = ${id} returning ${tx(COLS)}`;
    await auditCompetition(
      tx,
      existing.competition_id,
      "division_archived",
      { division_id: id, name: existing.name, slug: existing.slug },
      auth.userId,
    );
    archived = true;
    return row as DivisionRow;
  });
  if (archived) await expireCompetitionShell(auth.orgId, { competitionId: result.competition_id, divisionId: id });
  return result;
}

/** Restore an archived division. Re-checks the divisions quota — restoring
 *  must not smuggle a competition back over its plan limit. */
export async function restoreDivision(auth: AuthCtx, id: string): Promise<DivisionRow> {
  // The competition id, ahead of the transaction, ONLY to scope the plan lookup
  // below — an Event Pass lifts this cap for one competition, so dropping the
  // scope would change the answer. Authorisation is unaffected: the row itself
  // is read under RLS inside the transaction, which 404s for a foreign org.
  const [ref] = await sql<{ competition_id: string }[]>`
    select competition_id from divisions where id = ${id}`;
  // The plan LOOKUP is resolved out here; the COUNT stays inside the
  // transaction with the insert (doc 10 §2 rule 1). `getLimit` queries the
  // pooled `sql` proxy, and `withTenant` pins a pooled connection for its whole
  // callback — see `assertWithinLimit` in lib/entitlements.ts.
  const divisionCap = await getLimit(
    auth.orgId,
    "divisions.per_competition.max",
    ref?.competition_id,
  );
  let restored = false;
  const result = await withTenant(auth.orgId, async (tx) => {
    restored = false;
    const [existing] = await tx<DivisionRow[]>`
      select ${tx(COLS)} from divisions where id = ${id}`;
    if (!existing) throw new HttpError(404, "division not found");
    if (existing.archived_at === null) return existing;
    // Un-archiving is a create in every way that matters to the lifecycle: a
    // finished competition must not grow back either.
    await assertCompetitionNotEnded(tx, existing.competition_id);

    // Identical predicate to createDivision's (V354) — restoring must not
    // smuggle a competition past a limit a create would have refused. The row
    // being restored is EXCLUDED and re-added as the `+ 1` below: it is
    // archived, so under the old `archived_at is null` count it was never in
    // `n`, but a resulted archived division now IS, and counting it twice would
    // refuse a restore that fits.
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from divisions d
      where d.competition_id = ${existing.competition_id}
        and d.id <> ${id}
        and (d.archived_at is null
             or (division_has_results(d.id) and d.slot_waived_at is null))`;
    assertWithinLimit(divisionCap, "divisions.per_competition.max", n + 1);

    const [row] = await tx<DivisionRow[]>`
      update divisions set archived_at = null where id = ${id} returning ${tx(COLS)}`;
    await auditCompetition(
      tx,
      existing.competition_id,
      "division_restored",
      { division_id: id, name: existing.name, slug: existing.slug },
      auth.userId,
    );
    restored = true;
    return row as DivisionRow;
  });
  if (restored) await expireCompetitionShell(auth.orgId, { competitionId: result.competition_id, divisionId: id });
  return result;
}
