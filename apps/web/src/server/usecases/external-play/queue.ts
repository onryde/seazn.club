import "server-only";
// The organiser queue for online-play fixtures stuck in `needs_organiser`,
// read by the division page's fixtures tab. Rebuilt against V433: the
// pre-redesign reader was deleted in 340dce7ed together with the schema it
// read. Same shape the page already consumes, plus `reason` — V433 moved the
// why out of free-text `last_error` into the `needs_reason` vocabulary.
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { NEEDS_REASONS, type NeedsReason } from "@/server/external-play/types";
import { whiteSideOf, type Side } from "./guard";
import { isPlayableFixtureStatus } from "./preflight";
import { fixturesSeating } from "./seated";

export type NeedsOrganiserExternalPlayRow = {
  fixtureId: string;
  fixtureNo: number | null;
  homeName: string;
  awayName: string;
  scheduledAt: string | null;
  reason: NeedsReason;
  lastError: string | null;
  /** T16 — the queue names the players by colour (canvas HoldQueue), and the
   *  settle sends a SIDE: which side plays White. */
  whiteSide: Side;
  /** V436: the seat a `token_revoked` hold froze; null otherwise. */
  revokedSeat: "white" | "black" | "both" | null;
  roundNo: number | null;
  /** The board number in its round (`seq_in_round`, the room's boardNo). */
  boardNo: number | null;
  stageName: string;
  /** A game is on file at Lichess: "Resync from Lichess" can read it. */
  canResync: boolean;
  /** The viewer plays on this board: another organiser settles it (C). */
  seated: boolean;
};

const REVOKED_SEATS = ["white", "black", "both"] as const;
function readRevokedSeat(raw: unknown): NeedsOrganiserExternalPlayRow["revokedSeat"] {
  if (raw === null) return null;
  const seat = REVOKED_SEATS.find((x) => x === raw);
  // V436's CHECK keeps the column to these three; a drift is refused loudly.
  if (!seat) throw new HttpError(500, `revoked_seat outside its vocabulary: ${JSON.stringify(raw)}`, "REVOKED_SEAT_UNKNOWN");
  return seat;
}

/** V433's CHECK pairs `needs_organiser` with a non-null reason from the
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
  const rows = await withTenant(auth.orgId, async (tx) => {
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
        white_side: Side | null;
        revoked_seat: unknown;
        challenge_id: string | null;
        round_no: number | null;
        seq_in_round: number | null;
        stage_name: string;
      }[]
    >`
      select f.id as fixture_id, f.fixture_no, f.status as fixture_status,
             eh.display_name as home_name, ea.display_name as away_name,
             f.scheduled_at, ep.needs_reason, ep.last_error,
             ep.white_side, ep.revoked_seat, ep.challenge_id,
             f.round_no, f.seq_in_round, s.name as stage_name
        from fixture_external_play ep
        join fixtures f on f.id = ep.fixture_id
        join stages s on s.id = f.stage_id
        left join entrants eh on eh.id = f.home_entrant_id
        left join entrants ea on ea.id = f.away_entrant_id
       where f.division_id = ${divisionId}
         and ep.status = 'needs_organiser'
       order by f.scheduled_at nulls last, f.fixture_no nulls last`;
    return rows.filter((r) => isPlayableFixtureStatus(r.fixture_status));
  });
  // Outside the tenant transaction: both read with the privileged client.
  const seated = auth.userId === null || rows.length === 0 ? new Set<string>() : await fixturesSeating(auth.userId, rows.map((r) => r.fixture_id));
  return Promise.all(
    rows.map(async (r): Promise<NeedsOrganiserExternalPlayRow> => ({
      fixtureId: r.fixture_id,
      fixtureNo: r.fixture_no,
      homeName: r.home_name ?? "",
      awayName: r.away_name ?? "",
      scheduledAt: r.scheduled_at ? r.scheduled_at.toISOString() : null,
      reason: readNeedsReason(r.needs_reason),
      lastError: r.last_error,
      // Before a game exists the colour is the pairing's (guard.ts).
      whiteSide: r.white_side ?? (await whiteSideOf({ fixtureId: r.fixture_id, orgId: auth.orgId })),
      revokedSeat: readRevokedSeat(r.revoked_seat),
      roundNo: r.round_no,
      boardNo: r.seq_in_round,
      stageName: r.stage_name,
      canResync: r.challenge_id !== null,
      seated: seated.has(r.fixture_id),
    })),
  );
}
