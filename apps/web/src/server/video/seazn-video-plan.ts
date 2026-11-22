import "server-only";
// server/video/seazn-video-plan.ts — which player the public match page mounts for a fixture (Seazn-hosted video, Phase 1 Task 15; spec
// §5.1): the Seazn island, or the page's YouTube replay / link slot exactly as it was. Decided from the fixture's OWN facts, never from
// `fixtureStreamTarget` alone (it answers `{ id, label, source }` with no kind, and it answers today's default, which moves under a
// fixture that already streamed elsewhere):
//   1. any session of the fixture with destination_kind = 'seazn' -> `seazn`, WHATEVER the LIVE flag is (controller ruling 2026-11-20:
//      LIVE stops new Seazn streams, never playback of one that exists). Phase 1 reads `fixture_stream_sessions` alone; Task 25 adds
//      the replay-rows arm once V542 exists.
//   2. any other session, or a fixture that is over -> `external`: a fixture that streamed elsewhere, or is decided, can never flip to
//      Seazn because the org's default changed (the blocker: a past YouTube fixture with no saved choice would have lost its replay).
//   3. no session and not over -> `seazn` only when LIVE is on and the fixture's resolved target (its saved choice, else the org's
//      default) is a `seazn` row. The island then renders nothing until the route answers live, so a viewer who opens the page before
//      kick-off gets the player at live without a reload. With LIVE off the row is hidden from every resolver, and this arm answers
//      `external` without asking.
//
// "Over" is the match page's own bucket: `streamLinkLabelKey` calls `scheduled` and `in_play` the pre-match/live ones and every other
// status (decided, finalized, needs_decision, and the void ones) the rest; the list is held to `FIXTURE_STATUSES` by the compiler and
// to that function by this module's test, which sweeps every status.
//
// A `seazn` plan also says when the fixture is SETTLED (Phase 1 review I2): over, and past the stream code's grace after it finished
// (`CODE_GRACE_AFTER_FINISH_MINUTES`, read through `tunable` exactly as the code's own expiry reads it), so no new Go live can start
// on it. The island stops reading an empty answer from then on (seazn-video-schedule.ts). Null while it has no finish time (it is
// not over): the island then only backs off, it never stops.
//
// A `seazn` plan also says whether the page holds the player's box before the island's first read (`reserve`, Phase 1 visual D1):
// yes where a player is expected now (arm 1: a Seazn session, so its live or its recording), no before kick-off (arm 3), where
// "nothing yet" is the expected answer for hours and a held box would collapse on every load.
//
// And the island's poll hints (Phase 1 re-review N1): an empty answer holds the 30 s floor while the match is hot, else backs off to
// 60 s. `kickoffAt` is the fixture's `scheduled_at` (the island checks the hour either side of it on the viewer's clock, so a page
// opened early turns hot by itself). `activeUntil` is set when the fixture is in play, or a Seazn session of it is not terminal
// (requested through ending, so warming and live), as the page is drawn: the drawing instant + MAX_DURATION_MINUTES, the longest a session runs, so a page left
// open does not hold the floor for ever. Both are facts as of the render (the page is ISR); what starts later is caught within 60 s.
//
// The privileged `sql` client: fixture_stream_* are FORCE RLS with no policy (V410), the pattern seazn-video.ts reads them with.
import { sql } from "@/lib/db";
import type { FixtureStatusValue } from "@/lib/fixture-status";
import { CODE_GRACE_AFTER_FINISH_MINUTES, MAX_DURATION_MINUTES, seaznHostedLive, tunable } from "@/server/relay/config";
import { TERMINAL_STATES } from "@/server/relay/domain/session";
import { fixtureStreamTarget } from "@/server/usecases/stream-codes";

export type SeaznVideoPlan =
  | { player: "external" }
  | { player: "seazn"; settledAt: Date | null; reserve: boolean; kickoffAt: Date | null; activeUntil: Date | null };
const EXTERNAL: SeaznVideoPlan = { player: "external" };

/** A fixture id is a uuid; anything else names no fixture, and is answered before it reaches a query (22P02 would be a 500). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The statuses of a fixture that is not over: the only ones the third arm may answer `seazn` for. */
const NOT_OVER: readonly FixtureStatusValue[] = ["scheduled", "in_play"];

interface FixtureFacts {
  org_id: string; status: string; finished_at: Date | null; scheduled_at: Date | null;
  has_seazn_session: boolean; has_session: boolean; has_active_seazn_session: boolean;
}

/** N1: the island's hints, as of `now`. */
function hintsOf(facts: FixtureFacts, now: Date): { kickoffAt: Date | null; activeUntil: Date | null } {
  const active = facts.status === "in_play" || facts.has_active_seazn_session;
  return {
    kickoffAt: facts.scheduled_at === null ? null : new Date(facts.scheduled_at),
    activeUntil: active ? new Date(now.getTime() + MAX_DURATION_MINUTES * 60_000) : null,
  };
}

const isOver = (status: string): boolean => !(NOT_OVER as readonly string[]).includes(status);

/** When a fixture is settled: its finish plus the stream code's grace; null with no finish. `finished_at` is the database's own stamp
 *  of an over fixture (`fixtures_track_finished` stamps it on entering any status but scheduled and in_play, and clears it on going
 *  back), and the very input the stream code's expiry reads, so it is the one authority here. */
function settledAtOf(facts: FixtureFacts): Date | null {
  if (facts.finished_at === null) return null;
  const graceMinutes = tunable("CODE_GRACE_AFTER_FINISH_MINUTES", CODE_GRACE_AFTER_FINISH_MINUTES);
  return new Date(new Date(facts.finished_at).getTime() + graceMinutes * 60_000);
}

export async function seaznVideoPlan(fixtureId: string, now: Date = new Date()): Promise<SeaznVideoPlan> {
  if (!UUID.test(fixtureId)) return EXTERNAL;
  const [facts] = await sql<FixtureFacts[]>`
    select f.org_id, f.status, f.finished_at, f.scheduled_at,
           exists (select 1 from fixture_stream_sessions s where s.fixture_id = f.id and s.destination_kind = 'seazn') as has_seazn_session,
           exists (select 1 from fixture_stream_sessions s where s.fixture_id = f.id) as has_session,
           exists (select 1 from fixture_stream_sessions s
                    where s.fixture_id = f.id and s.destination_kind = 'seazn' and s.state not in ${sql([...TERMINAL_STATES])}) as has_active_seazn_session
      from fixtures f
     where f.id = ${fixtureId}`;
  if (facts === undefined) return EXTERNAL;
  if (facts.has_seazn_session) return { player: "seazn", settledAt: settledAtOf(facts), reserve: true, ...hintsOf(facts, now) };
  if (facts.has_session || isOver(facts.status)) return EXTERNAL;
  if (!seaznHostedLive()) return EXTERNAL;
  // The fixture's own pick: the same resolver the panel's picker and the phone's start read, so the player appears exactly when
  // Go live would stream to Seazn. Its answer names no kind, so the kind is read off the row it picked. Not over: never settled.
  const pick = await fixtureStreamTarget(sql, { orgId: facts.org_id, fixtureId });
  if (pick === null) return EXTERNAL;
  const [target] = await sql<{ kind: string }[]>`select kind from org_stream_targets where id = ${pick.id}`;
  return target?.kind === "seazn" ? { player: "seazn", settledAt: null, reserve: false, ...hintsOf(facts, now) } : EXTERNAL;
}
