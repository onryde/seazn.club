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
//
// A guest's committed score is never deleted (Task 2 review m1). The scoring path touches the match only AFTER its append
// commits (scoring.ts), so a score can stand while `last_activity_at` still says idle. Two more checks close that gap:
//   - a score still in flight: an append that has written its event holds the event's fixture (its foreign key) until it
//     commits, and a delete that went ahead would wait for that commit and then cascade the score away. So the delete takes
//     every fixture of the competition `for update skip locked` first, and keeps the match when any is held. An append that
//     has not reached its fixture yet meets this lock, and finds the fixture gone once the delete commits (it fails, nothing
//     committed is lost).
//   - a score committed but not yet touched: read after those locks, so every append that could still commit is held or
//     blocked. A score inside the expiry window C1 gives (the last QUICK_MATCH_EXPIRY_DAYS) keeps the match, which bounds a
//     LOST touch (best-effort, logged) to the same 7 days a recorded one would have bought.
//
// A match kept for either reason gets the touch it lost, in the same transaction under the same lock (branch review B m1,
// controller PO rec 2026-11-08): its clock moves to its latest committed score, so its expiry is that score plus
// QUICK_MATCH_EXPIRY_DAYS and its reminder is owed again, exactly as the touch would have left it. Without that, the row was
// kept yet dead to every other reader for up to 7 days: the home's resolver, the Save button and the reminder all read the
// expiry, which still said "past". Forward only: a score older than the clock (a home tap recorded later) moves nothing, and
// a match with no committed score (kept for an append still in flight, whose own touch follows its commit) is left alone.
import { sql, type Tx } from "@/lib/db";
import { QUICK_MATCH_EXPIRY_DAYS, QUICK_MATCH_SYSTEM_ORG_ID } from "@/lib/quick-match-constants";

/** The email outbox's free-text reference for a quick match's mails (V470: `ref_type`/`ref_id`, no foreign key). */
export const QUICK_MATCH_OUTBOX_REF_TYPE = "quick_match";

/** What must still hold at the moment of a conditional delete, read under the row's lock:
 *  - `expiredBefore`: the match is unsaved and its expiry is strictly before this instant (the expiry sweep);
 *  - `orphanedBefore`: the competition has no `quick_matches` row and was created strictly before this instant (the
 *    sweep's orphan step: a create that died between its two commits). */
export type QuickMatchDeleteGuard = { expiredBefore: Date } | { orphanedBefore: Date };

/** `deleted`: the competition's delete removed its row. `kept`: a guard was given and no longer holds (the match was
 *  revived or saved, another transaction holds its row, or a guest's score stands, whose touch it then gets: see the
 *  header), so nothing was deleted and the caller may judge it again later.
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
    if (!row) {
      const [held] = await tx`
        select 1 from quick_matches where competition_id = ${competitionId} and org_id = ${QUICK_MATCH_SYSTEM_ORG_ID}`;
      return held ? "kept" : "gone";
    }
    if (row.due !== true) return "kept";
    if (!(await scoreStands(tx, competitionId, guard.expiredBefore))) return "due";
    await touchFromLatestScore(tx, competitionId);
    return "kept";
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

/** Is a guest's score in flight, or committed inside the expiry window, on this competition? (See the header.) */
async function scoreStands(tx: Tx, competitionId: string, before: Date): Promise<boolean> {
  const [all] = await tx<{ n: number }[]>`
    select count(*)::int as n from fixtures f join divisions d on d.id = f.division_id where d.competition_id = ${competitionId}`;
  const locked = await tx`
    select f.id from fixtures f join divisions d on d.id = f.division_id where d.competition_id = ${competitionId}
       for update of f skip locked`;
  if (locked.length < (all?.n ?? 0)) return true;
  const [recent] = await tx`
    select 1 from score_events se
      join fixtures f on f.id = se.fixture_id
      join divisions d on d.id = f.division_id
     where d.competition_id = ${competitionId}
       and se.recorded_at > ${before}::timestamptz - make_interval(days => ${QUICK_MATCH_EXPIRY_DAYS}::int)
     limit 1`;
  return recent !== undefined;
}

/** The lost touch, for a match `scoreStands` kept (see the header): last activity, expiry and reminder moved to the latest
 *  committed score, forward only. The caller holds the row's lock. */
async function touchFromLatestScore(tx: Tx, competitionId: string): Promise<void> {
  await tx`
    update quick_matches q
       set last_activity_at = greatest(q.last_activity_at, s.latest),
           expires_at = s.latest + make_interval(days => ${QUICK_MATCH_EXPIRY_DAYS}::int),
           reminder_sent_at = null
      from (select max(se.recorded_at) as latest
              from score_events se
              join fixtures f on f.id = se.fixture_id
              join divisions d on d.id = f.division_id
             where d.competition_id = ${competitionId}) s
     where q.competition_id = ${competitionId} and q.org_id = ${QUICK_MATCH_SYSTEM_ORG_ID} and q.saved_by_user_id is null
       and s.latest + make_interval(days => ${QUICK_MATCH_EXPIRY_DAYS}::int) > q.expires_at`;
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
