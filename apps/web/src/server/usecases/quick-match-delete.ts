import "server-only";
// Quick match (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §7.8): the hard delete of one quick match's
// competition. PRIVILEGED — the pooled role, not a tenant transaction — because two of the rows it removes are reached
// by no foreign key the database could cascade along, and its callers act for no organizer:
//   - the create's compensation (quick-match-create.ts), when a create fails after its competition exists;
//   - the expiry sweep (quick-match-sweep.ts), for an unsaved match idle past its expiry, and for an orphan competition.
//
// `deleteCompetition` cannot serve either: it refuses (409) any competition with score events, and a scored match is
// exactly what the sweep removes. The database does the rest along §7.8's cascade: competitions → divisions → stages →
// fixtures → score_events, entrants, device links and the rest, all ON DELETE CASCADE.
//
// The sweep's deletes are CONDITIONAL (plan-1 T8 review, plan 3 Task 2): the sweep reads its candidates without a lock, so
// a score can land between that read and the delete and revive the match. The condition is therefore read again inside
// the delete's own transaction, under the row's lock (`for update skip locked`): a match revived, saved or still locked by
// another transaction (a touch in flight, an overlapping sweep) is KEPT, and the sweep's next run judges it again.
import { sql, type Tx } from "@/lib/db";
import { QUICK_MATCH_SYSTEM_ORG_ID } from "@/lib/quick-match-constants";

/** The email outbox's free-text reference for a quick match's mails (V470: `ref_type`/`ref_id`, no foreign key). */
export const QUICK_MATCH_OUTBOX_REF_TYPE = "quick_match";

/** What must still hold at the moment of a conditional delete, read under the row's lock:
 *  - `expiredBefore`: the match is unsaved and its expiry is strictly before this instant (the expiry sweep);
 *  - `orphanedBefore`: the competition has no `quick_matches` row and was created strictly before this instant (the
 *    sweep's orphan step: a create that died between its two commits). */
export type QuickMatchDeleteGuard = { expiredBefore: Date } | { orphanedBefore: Date };

/** `deleted`: the competition's delete removed its row. `kept`: a guard was given and no longer holds (the match was
 *  revived or saved, or another transaction holds its row), so nothing was deleted and the caller may judge it again later.
 *  Both false: there was nothing of the system org's to delete (gone already, or another org's). */
export interface QuickMatchDeleteResult {
  deleted: boolean;
  kept: boolean;
}

/** Does the guard still hold for this competition, read under its row's lock? `gone` when no system-org row is left to judge. */
async function judge(tx: Tx, competitionId: string, guard: QuickMatchDeleteGuard): Promise<"due" | "kept" | "gone"> {
  if ("expiredBefore" in guard) {
    const [row] = await tx<{ due: boolean | null }[]>`
      select (saved_by_user_id is null and expires_at < ${guard.expiredBefore}) as due
        from quick_matches
       where competition_id = ${competitionId} and org_id = ${QUICK_MATCH_SYSTEM_ORG_ID}
         for update skip locked`;
    if (row) return row.due === true ? "due" : "kept";
    const [held] = await tx`
      select 1 from quick_matches where competition_id = ${competitionId} and org_id = ${QUICK_MATCH_SYSTEM_ORG_ID}`;
    return held ? "kept" : "gone";
  }
  const [row] = await tx<{ due: boolean | null }[]>`
    select (c.created_at < ${guard.orphanedBefore}
            and not exists (select 1 from quick_matches q where q.competition_id = c.id)) as due
      from competitions c
     where c.id = ${competitionId} and c.org_id = ${QUICK_MATCH_SYSTEM_ORG_ID}
       for update of c skip locked`;
  if (row) return row.due === true ? "due" : "kept";
  const [held] = await tx`select 1 from competitions where id = ${competitionId} and org_id = ${QUICK_MATCH_SYSTEM_ORG_ID}`;
  return held ? "kept" : "gone";
}

/** Delete one quick match's competition and everything hanging off it, in one transaction: its outbox mails (by their
 *  free-text reference to the `quick_matches` id), its `quick_matches` row, then the competition (which cascades). A
 *  competition with no `quick_matches` row (a create that failed before its last transaction committed) deletes the
 *  same way. A competition that does not exist, or that belongs to any org but the quick match system org, deletes
 *  nothing: this runs on the pooled role, past RLS, so the org is the predicate. With a `guard`, the delete happens only
 *  if the guard still holds under the row's lock (see the header). */
export async function hardDeleteQuickMatchCompetition(
  competitionId: string,
  guard?: QuickMatchDeleteGuard,
): Promise<QuickMatchDeleteResult> {
  return sql.begin(async (tx) => {
    if (guard !== undefined) {
      const verdict = await judge(tx, competitionId, guard);
      if (verdict !== "due") return { deleted: false, kept: verdict === "kept" };
    }
    const rows = await tx<{ id: string }[]>`
      select id from quick_matches where competition_id = ${competitionId} and org_id = ${QUICK_MATCH_SYSTEM_ORG_ID}`;
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      await tx`delete from email_outbox where ref_type = ${QUICK_MATCH_OUTBOX_REF_TYPE} and ref_id = any(${ids}::text[])`;
    }
    await tx`delete from quick_matches where competition_id = ${competitionId} and org_id = ${QUICK_MATCH_SYSTEM_ORG_ID}`;
    const removed = await tx`delete from competitions where id = ${competitionId} and org_id = ${QUICK_MATCH_SYSTEM_ORG_ID}`;
    return { deleted: removed.count > 0, kept: false };
  });
}
