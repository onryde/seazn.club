import "server-only";
// The organiser queue for online-play fixtures stuck in `needs_organiser`,
// read by the division page's fixtures tab. Rebuilt against V432: the
// pre-redesign reader was deleted in 340dce7ed together with the schema it
// read. Same shape the page already consumes, plus `reason` — V432 moved the
// why out of free-text `last_error` into the `needs_reason` vocabulary.
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { NEEDS_REASONS, type NeedsReason } from "@/server/external-play/types";
import { isPlayableFixtureStatus } from "./preflight";

export type NeedsOrganiserExternalPlayRow = {
  fixtureId: string;
  fixtureNo: number | null;
  homeName: string;
  awayName: string;
  scheduledAt: string | null;
  reason: NeedsReason;
  lastError: string | null;
};

/** V432's CHECK pairs `needs_organiser` with a non-null reason from the
 *  vocabulary, so a row outside it cannot exist. A guard, not a comment: if
 *  the CHECK and NEEDS_REASONS ever drift, refuse loudly instead of handing
 *  the queue a reason nothing can label. */
export function readNeedsReason(raw: unknown): NeedsReason {
  const reason = NEEDS_REASONS.find((r) => r === raw);
  if (!reason) {
    throw new HttpError(500, `needs_organiser row with unknown reason ${JSON.stringify(raw)}`, "NEEDS_REASON_UNKNOWN");
  }
  return reason;
}

/** The division's online-play fixtures waiting for an organiser decision,
 *  earliest first. Tenancy is the tenant transaction: fixture_external_play
 *  is FORCE RLS on org_id, so another organisation's division id reads
 *  nothing.
 *
 *  "Waiting" is the FIXTURE's state as much as the bridge's: a fixture
 *  settled through another path — a result or a void entered in the console,
 *  a withdrawal's walkover or abandon — has had its decision, whatever its
 *  bridge row still says (T6 follow-up review Minor 8). The one authority for
 *  "still to be played" is T8's `isPlayableFixtureStatus`. */
export async function listNeedsOrganiserExternalPlay(
  auth: AuthCtx,
  divisionId: string,
): Promise<NeedsOrganiserExternalPlayRow[]> {
  return withTenant(auth.orgId, async (tx) => {
    const rows = await tx<
      {
        fixture_id: string;
        fixture_no: number | null;
        home_name: string | null;
        away_name: string | null;
        scheduled_at: Date | null;
        fixture_status: string;
        needs_reason: unknown;
        last_error: string | null;
      }[]
    >`
      select f.id as fixture_id, f.fixture_no, f.status as fixture_status,
             eh.display_name as home_name, ea.display_name as away_name,
             f.scheduled_at, ep.needs_reason, ep.last_error
        from fixture_external_play ep
        join fixtures f on f.id = ep.fixture_id
        left join entrants eh on eh.id = f.home_entrant_id
        left join entrants ea on ea.id = f.away_entrant_id
       where f.division_id = ${divisionId}
         and ep.status = 'needs_organiser'
       order by f.scheduled_at nulls last, f.fixture_no nulls last`;
    return rows.filter((r) => isPlayableFixtureStatus(r.fixture_status)).map((r) => ({
      fixtureId: r.fixture_id,
      fixtureNo: r.fixture_no,
      homeName: r.home_name ?? "",
      awayName: r.away_name ?? "",
      scheduledAt: r.scheduled_at ? r.scheduled_at.toISOString() : null,
      reason: readNeedsReason(r.needs_reason),
      lastError: r.last_error,
    }));
  });
}
