import "server-only";
// server/video/seazn-video-plan.ts — which player the public match page mounts for a fixture (Seazn-hosted video, Phase 1 Task 15; spec
// §5.1): the Seazn island, or the page's YouTube replay / link slot exactly as it was. Decided from the fixture's OWN facts, never from
// `fixtureStreamTarget` alone (it answers `{ id, label, source }` with no kind, and it answers today's default, which moves under a
// fixture that already streamed elsewhere):
//   1. any session of the fixture with destination_kind = 'seazn' -> `seazn`, WHATEVER the LIVE flag is (controller ruling 2026-11-20:
//      LIVE stops new Seazn streams, never playback of one that exists). Phase 1 reads `fixture_stream_sessions` alone; Task 25 adds
//      the replay-rows arm once V541 exists.
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
// The privileged `sql` client: fixture_stream_* are FORCE RLS with no policy (V410), the pattern seazn-video.ts reads them with.
import { sql } from "@/lib/db";
import type { FixtureStatusValue } from "@/lib/fixture-status";
import { seaznHostedLive } from "@/server/relay/config";
import { fixtureStreamTarget } from "@/server/usecases/stream-codes";

export type SeaznVideoPlan = "seazn" | "external";

/** A fixture id is a uuid; anything else names no fixture, and is answered before it reaches a query (22P02 would be a 500). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The statuses of a fixture that is not over: the only ones the third arm may answer `seazn` for. */
const NOT_OVER: readonly FixtureStatusValue[] = ["scheduled", "in_play"];

interface FixtureFacts { org_id: string; status: string; has_seazn_session: boolean; has_session: boolean }

export async function seaznVideoPlan(fixtureId: string): Promise<SeaznVideoPlan> {
  if (!UUID.test(fixtureId)) return "external";
  const [facts] = await sql<FixtureFacts[]>`
    select f.org_id, f.status,
           exists (select 1 from fixture_stream_sessions s where s.fixture_id = f.id and s.destination_kind = 'seazn') as has_seazn_session,
           exists (select 1 from fixture_stream_sessions s where s.fixture_id = f.id) as has_session
      from fixtures f
     where f.id = ${fixtureId}`;
  if (facts === undefined) return "external";
  if (facts.has_seazn_session) return "seazn";
  if (facts.has_session || !(NOT_OVER as readonly string[]).includes(facts.status)) return "external";
  if (!seaznHostedLive()) return "external";
  // The fixture's own pick: the same resolver the panel's picker and the phone's start read, so the player appears exactly when
  // Go live would stream to Seazn. Its answer names no kind, so the kind is read off the row it picked.
  const pick = await fixtureStreamTarget(sql, { orgId: facts.org_id, fixtureId });
  if (pick === null) return "external";
  const [target] = await sql<{ kind: string }[]>`select kind from org_stream_targets where id = ${pick.id}`;
  return target?.kind === "seazn" ? "seazn" : "external";
}
