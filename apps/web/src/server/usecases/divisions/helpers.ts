import "server-only";
import type postgres from "postgres";
import { HttpError } from "@/lib/errors";
import { competitionIsEnded } from "@/lib/entitlements";

/**
 * U-anything eligibility (age_max below 18) marks a division youth. RS007/
 * V380 repoints this at the first-class `age_max` column — the ONE place
 * `youth` derives from now, replacing three prior derivations (this
 * function's old jsonb-scanning body, its INSERT-time call below, and its
 * PATCH-time re-derive) plus a fourth, independent raw-SQL recompute in
 * `settings/page.tsx` that now just reads the `youth` column directly.
 */
export function deriveYouth(ageMax: number | null): boolean {
  return ageMax != null && ageMax < 18;
}

/**
 * A finished competition does not grow (#376 branch, part D).
 *
 * `assertCompetitionNotFrozen` checks the over-quota freeze and says nothing
 * about status, so a completed or archived competition accepted new divisions.
 * Not a quota leak — the per-competition cap still binds — but it made
 * "completed" mean nothing, and it contradicted the same competition being
 * refused an Event Pass.
 *
 * TERMINAL ONLY. `past_ends_on` must keep accepting writes: that arm is
 * routinely a stale end date on a competition still being played, which is why
 * the pass chip points that organiser at the settings form. The pass line and
 * the write line share a vocabulary, not a threshold.
 *
 * Takes the CALLER'S tx: the status it refuses on must be the one the insert
 * would have run against, and a read outside the transaction could see a
 * different snapshot.
 */
export async function assertCompetitionNotEnded(tx: postgres.TransactionSql, competitionId: string) {
  const [comp] = await tx<{ status: string }[]>`
    select status from competitions where id = ${competitionId}`;
  if (comp && competitionIsEnded(comp.status)) {
    throw new HttpError(
      409,
      "This competition is finished, so no new divisions can be added to it",
      "COMPETITION_ENDED",
    );
  }
}
