import "server-only";
// Quick match (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §7.8): the hard delete of one quick match's
// competition. PRIVILEGED — the pooled role, not a tenant transaction — because two of the rows it removes are reached
// by no foreign key the database could cascade along, and its callers act for no organizer:
//   - the create's compensation (quick-match-create.ts), when a create fails after its competition exists;
//   - the expiry sweep (plan 3), for an unsaved match idle past its expiry.
//
// `deleteCompetition` cannot serve either: it refuses (409) any competition with score events, and a scored match is
// exactly what the sweep removes. The database does the rest along §7.8's cascade: competitions → divisions → stages →
// fixtures → score_events, entrants, device links and the rest, all ON DELETE CASCADE.
import { sql } from "@/lib/db";
import { QUICK_MATCH_SYSTEM_ORG_ID } from "@/lib/quick-match-constants";

/** The email outbox's free-text reference for a quick match's mails (V470: `ref_type`/`ref_id`, no foreign key). */
export const QUICK_MATCH_OUTBOX_REF_TYPE = "quick_match";

/** Delete one quick match's competition and everything hanging off it, in one transaction: its outbox mails (by their
 *  free-text reference to the `quick_matches` id), its `quick_matches` row, then the competition (which cascades). A
 *  competition with no `quick_matches` row (a create that failed before its last transaction committed) deletes the
 *  same way. A competition that does not exist, or that belongs to any org but the quick match system org, deletes
 *  nothing: this runs on the pooled role, past RLS, so the org is the predicate. */
export async function hardDeleteQuickMatchCompetition(competitionId: string): Promise<void> {
  await sql.begin(async (tx) => {
    const rows = await tx<{ id: string }[]>`
      select id from quick_matches where competition_id = ${competitionId} and org_id = ${QUICK_MATCH_SYSTEM_ORG_ID}`;
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      await tx`delete from email_outbox where ref_type = ${QUICK_MATCH_OUTBOX_REF_TYPE} and ref_id = any(${ids}::text[])`;
    }
    await tx`delete from quick_matches where competition_id = ${competitionId} and org_id = ${QUICK_MATCH_SYSTEM_ORG_ID}`;
    await tx`delete from competitions where id = ${competitionId} and org_id = ${QUICK_MATCH_SYSTEM_ORG_ID}`;
  });
}
