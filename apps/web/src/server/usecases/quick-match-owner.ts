import "server-only";
// Quick match (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §7.7, C13; plan 3 Task 6, Amend T6 [B27, B28, D14]):
// what the saver, and only the saver, may do to a saved quick match from their account: rename it, and delete it for everyone.
// Anyone with the link can still score it (C13); these two are the saver's alone. The route (app/api/quick-match/[id]/route.ts)
// has already refused a signed-out caller and a staff impersonation; these take the signed-in person's id.
//
// "Not yours" and "no such match" are ONE answer, 404 QUICK_MATCH_NOT_IN_ACCOUNT (B28): someone else's match, nobody's, one past
// its expiry, one deleted already, or an id that is no uuid. A caller can never learn that a match it does not hold exists.
//
// Rename (D14, B27): the name the create copied into four places (the `quick_matches` row, the competition, the division and its
// stages, quick-match-create.ts and quickMatchStageInputs: one stage, or a League + Knockout's two, plan 5 D10) changes in all
// of them, in ONE system-org transaction of plain UPDATEs,
// never through `updateCompetition`: its rename regenerates the slug and writes `slug_history` (competitions.ts, slugs.ts), a
// keyless row the hard delete would orphan, and a private guest competition has no public URL whose slug is worth keeping. The
// name is `CreateQuickMatch`'s own (trimmed, 1 to QUICK_MATCH_NAME_MAX), so a renamed match is one the create could have made.
//
// Delete: the hard delete every other quick match path uses (quick-match-delete.ts), with the saver's guard read under the
// row's lock inside the delete's own transaction, so the check and the delete are one step.
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { QUICK_MATCH_ERRORS, QUICK_MATCH_NAME_MAX, QUICK_MATCH_SYSTEM_ORG_ID } from "@/lib/quick-match-constants";
import { CreateQuickMatch } from "@/server/api-v1/schemas";
import { hardDeleteQuickMatchCompetition } from "./quick-match-delete";
import { quickMatchStageCount, type QuickMatchFormat } from "./quick-match-preview";
import { announceQuickMatchDeleted, deletedFactsSql, type QuickMatchDeletedFacts } from "./quick-match-deleted-event";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notInAccount = () => new HttpError(404, "No quick match of yours goes by that id.", QUICK_MATCH_ERRORS.NOT_IN_ACCOUNT);

/**
 * Rename the quick match `quickMatchId` that `userId` saved to `name` (anything a client sent: it is checked here). Returns the
 * stored name, trimmed. Refuses 422 RENAME_INVALID for a name the create would refuse, then 404 NOT_IN_ACCOUNT for a match this
 * person does not hold. A quick match that is not the create's shape (one competition, one division, and the stages its format is
 * built with: `quickMatchStageCount`) is a fault, and nothing is renamed.
 */
export async function renameSavedQuickMatch(userId: string, quickMatchId: string, name: unknown): Promise<{ id: string; name: string }> {
  const parsed = CreateQuickMatch.shape.name.safeParse(name);
  if (!parsed.success) {
    throw new HttpError(422, `A quick match's name is 1 to ${QUICK_MATCH_NAME_MAX} characters.`, QUICK_MATCH_ERRORS.RENAME_INVALID);
  }
  const next = parsed.data;
  if (!UUID.test(quickMatchId)) throw notInAccount();
  return withTenant(QUICK_MATCH_SYSTEM_ORG_ID, async (tx) => {
    // Held, and locked: a delete or a release waiting on this row sees the rename's outcome, never half of it.
    const [row] = await tx<{ competition_id: string; format: QuickMatchFormat }[]>`
      select competition_id, format from quick_matches where id = ${quickMatchId} and saved_by_user_id = ${userId} for update`;
    if (!row) throw notInAccount();
    const competitionId = row.competition_id;
    await tx`update quick_matches set name = ${next} where id = ${quickMatchId}`;
    const competitions = await tx`update competitions set name = ${next} where id = ${competitionId}`;
    const divisions = await tx`update divisions set name = ${next} where competition_id = ${competitionId}`;
    const stages = await tx`
      update stages set name = ${next} where division_id in (select id from divisions where competition_id = ${competitionId})`;
    // The create's shape is one competition, one division and the stages its format is built with (readQuickMatchHome refuses
    // anything else too). Any other count is a quick match this rename does not understand: refuse the whole of it rather than
    // leave the names disagreeing.
    const counts = { competitions: competitions.count, divisions: divisions.count, stages: stages.count };
    const owed = { competitions: 1, divisions: 1, stages: quickMatchStageCount(row.format) };
    if (counts.competitions !== owed.competitions || counts.divisions !== owed.divisions || counts.stages !== owed.stages) {
      throw new Error(`quick match ${quickMatchId}: rename found ${JSON.stringify(counts)}, not ${JSON.stringify(owed)}`);
    }
    return { id: quickMatchId, name: next };
  });
}

/** Delete, for everyone, the quick match `quickMatchId` that `userId` saved: the hard delete, its saver read again under the row's
 *  lock. 404 NOT_IN_ACCOUNT when this person does not hold it (a second delete included). */
export async function deleteSavedQuickMatch(userId: string, quickMatchId: string): Promise<void> {
  if (!UUID.test(quickMatchId)) throw notInAccount();
  // Which competition the id names, whoever holds it: the saver is checked once, by the delete's own guard, under the lock.
  // With what `quick_match_deleted` carries, read before the delete removes it: the row's OWN id (the uuid as stored, never the
  // caller's spelling of it, which may differ in case), its sport and its kind.
  const [row] = await sql<({ id: string; competition_id: string } & QuickMatchDeletedFacts)[]>`
    select q.id, q.competition_id, ${deletedFactsSql()}
      from quick_matches q where q.id = ${quickMatchId} and q.org_id = ${QUICK_MATCH_SYSTEM_ORG_ID}`;
  if (!row) throw notInAccount();
  const { deleted } = await hardDeleteQuickMatchCompetition(row.competition_id, { savedBy: userId });
  if (!deleted) throw notInAccount();
  announceQuickMatchDeleted("saver", row.id, row, userId);
}
