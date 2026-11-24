import "server-only";
// server/video/seazn-video-plan.ts — which player the public match page mounts for a fixture (Seazn-hosted video, Phase 1 Task 15; spec
// §5.1): the Seazn island, or the page's YouTube replay / link slot exactly as it was. Decided from the fixture's OWN facts, never from
// `fixtureStreamTarget` alone (it answers `{ id, label, source }` with no kind, and it answers today's default, which moves under a
// fixture that already streamed elsewhere):
//   1. any session of the fixture with destination_kind = 'seazn', or any replay row of it the organiser has not removed
//      (`fixture_video_replays`, Task 25) -> `seazn`, WHATEVER the LIVE and REPLAY flags are (controller ruling 2026-11-20: LIVE stops
//      new Seazn streams, never playback of one that exists; REPLAY gates the move, never playing what it moved).
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
// A `seazn` plan also says whether the page holds the player's box before the island's first read (`reserve`, Phase 1 visual D1, narrowed
// by review m2): yes where a player is EXPECTED: the fixture's latest session is a Seazn session still in flight (its live, or on its way
// to one or to its recording), a wait is on (below), or the route will offer a recording (`replayParts`). No before kick-off (arm 3),
// where "nothing yet" is the expected answer for hours, and none where the last Seazn session ended with nothing to play (a failed Go
// live, a stop that recorded nothing, a recording Cloudflare has deleted): the route answers the empty video on every load there, so a held
// box would collapse every time. A Go live that comes later on that open page is caught by the island's loop, as it is before kick-off.
//
// A `seazn` plan also says whether a WAIT is on (`holdUntil`, Phase 1 visual re-capture R2): the island holds its box, with one quiet
// line, through answers with nothing to play until then (seazn-video-hold.ts). It is on while the fixture's LATEST session (the video
// route's own meaning of "the session") is a Seazn session that is not yet live (requested, provisioning, warming: the ladder,
// `MAX_ANCHOR_DRIFT_SECONDS` from the session's CREATION), is being stopped (`ending`: the ending backstop from `ending_at`, then the
// recording's path), or COMPLETED a moment ago (the recording's path from its `ended_at`: `SEAZN_RECORDING_SHOWN_BY_MS`, which is
// Cloudflare's finish, the stream tick that locks it, and one read). Every one is counted from the SESSION's own time, never from the
// render (review m1), so a page drawn late does not promise a video for longer than the session could take. Never while it is live (its
// answer is the player), nor for a failed session (it never recorded), nor once a session of another kind follows.
//
// And the replay's part numbers (`replayParts`, re-capture R1): the numbers the video route will offer as parts, as of this render
// (`seaznReplayPartNos`, the route's own numbering), so the island holds the picker's row before its first read when there are two or
// more. Empty while the latest session is live: the route's answer is then the live player, which has no picker.
//
// And whether a LIVE is what the page expects next (`liveExpected`, Task 33c): the fixture's LATEST session is a Seazn session on its
// way up or live (every active state up to `live`: the route answers a live only in `live`, seazn-live.ts). The live player carries one
// more row, its delay line, so the box the island holds keeps that row, invisible, and the live arrives with no shift. Never while it is
// being stopped or after (a recording comes next, which has no line), nor for an unstarted fixture (arm 3: no box is held there).
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
import { SEAZN_RECORDING_SHOWN_BY_MS } from "@/components/public-site/match-centre/seazn-video-hold";
import { CODE_GRACE_AFTER_FINISH_MINUTES, ENDING_TIMEOUT_SECONDS, MAX_ANCHOR_DRIFT_SECONDS, MAX_DURATION_MINUTES, seaznHostedLive, tunable } from "@/server/relay/config";
import { ACTIVE_STATES, TERMINAL_STATES, type SessionState, isTerminal } from "@/server/relay/domain/session";
import { fixtureStreamTarget } from "@/server/usecases/stream-codes";
import { seaznReplayPartNos } from "./seazn-video";

export type SeaznVideoPlan =
  | { player: "external" }
  | {
      player: "seazn"; settledAt: Date | null; reserve: boolean; liveExpected: boolean; holdUntil: Date | null; replayParts: number[];
      kickoffAt: Date | null; activeUntil: Date | null;
    };
const EXTERNAL: SeaznVideoPlan = { player: "external" };

/** A fixture id is a uuid; anything else names no fixture, and is answered before it reaches a query (22P02 would be a 500). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The statuses of a fixture that is not over: the only ones the third arm may answer `seazn` for. */
const NOT_OVER: readonly FixtureStatusValue[] = ["scheduled", "in_play"];

interface FixtureFacts {
  org_id: string; status: string; finished_at: Date | null; scheduled_at: Date | null;
  has_seazn_session: boolean; has_seazn_replay: boolean; has_session: boolean; has_active_seazn_session: boolean;
  /** The fixture's LATEST session (by creation, the video route's own reading): its kind and state and the three times the wait is counted
   *  from (its creation, the instant it began ending, its end); all null with no session. */
  latest_kind: string | null; latest_state: string | null; latest_created: Date | null; latest_ending: Date | null; latest_ended: Date | null;
}

/** N1: the island's hints, as of `now`. */
function hintsOf(facts: FixtureFacts, now: Date): { kickoffAt: Date | null; activeUntil: Date | null } {
  const active = facts.status === "in_play" || facts.has_active_seazn_session;
  return {
    kickoffAt: facts.scheduled_at === null ? null : new Date(facts.scheduled_at),
    activeUntil: active ? new Date(now.getTime() + MAX_DURATION_MINUTES * 60_000) : null,
  };
}

/** Re-capture R2: until when an empty answer is a wait, from the latest session's OWN times (see the header; review I1 and m1). Null: none. */
function holdOf(facts: FixtureFacts, now: Date): Date | null {
  if (facts.latest_kind !== "seazn" || facts.latest_state === null || facts.latest_created === null) return null;
  const ms = (d: Date | string): number => new Date(d).getTime();
  const created = ms(facts.latest_created);
  let closes: number;
  switch (facts.latest_state as SessionState) {
    case "requested": case "provisioning": case "warming":
      closes = created + MAX_ANCHOR_DRIFT_SECONDS * 1000;
      break;
    case "ending":
      closes = (facts.latest_ending === null ? created : ms(facts.latest_ending)) + ENDING_TIMEOUT_SECONDS * 1000 + SEAZN_RECORDING_SHOWN_BY_MS;
      break;
    case "completed":
      closes = (facts.latest_ended === null ? created : ms(facts.latest_ended)) + SEAZN_RECORDING_SHOWN_BY_MS;
      break;
    default:
      return null;   // live: its answer is the player; failed: it never recorded
  }
  return closes > now.getTime() ? new Date(closes) : null;
}

/** Review m2: whether a Seazn player is EXPECTED when the page is drawn, so its box is held before the first read (see the header). */
const expectsPlayer = (facts: FixtureFacts, holdUntil: Date | null, replayParts: number[]): boolean =>
  (facts.latest_kind === "seazn" && facts.latest_state !== null && !isTerminal(facts.latest_state as SessionState)) || holdUntil !== null || replayParts.length > 0;

/** Task 33c: the states of the latest Seazn session in which a live is what comes next: the session's ladder up to and including `live`. */
const LIVE_NEXT_STATES: readonly SessionState[] = ACTIVE_STATES.slice(0, ACTIVE_STATES.indexOf("live") + 1);
const expectsLive = (facts: FixtureFacts): boolean =>
  facts.latest_kind === "seazn" && facts.latest_state !== null && LIVE_NEXT_STATES.includes(facts.latest_state as SessionState);

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
           exists (select 1 from fixture_video_replays r
                    where r.fixture_id = f.id and r.state <> 'deleted' and r.deleted_at is null) as has_seazn_replay,
           exists (select 1 from fixture_stream_sessions s where s.fixture_id = f.id) as has_session,
           exists (select 1 from fixture_stream_sessions s
                    where s.fixture_id = f.id and s.destination_kind = 'seazn' and s.state not in ${sql([...TERMINAL_STATES])}) as has_active_seazn_session,
           l.destination_kind as latest_kind, l.state as latest_state, l.created_at as latest_created, l.ending_at as latest_ending, l.ended_at as latest_ended
      from fixtures f
      left join lateral (select s.destination_kind, s.state, s.ending_at, s.ended_at, s.created_at from fixture_stream_sessions s
                          where s.fixture_id = f.id order by s.created_at desc, s.id desc limit 1) l on true
     where f.id = ${fixtureId}`;
  if (facts === undefined) return EXTERNAL;
  if (facts.has_seazn_session || facts.has_seazn_replay) {
    const live = facts.latest_kind === "seazn" && facts.latest_state === "live";
    const replayParts = live ? [] : await seaznReplayPartNos(fixtureId, now);
    const holdUntil = holdOf(facts, now);
    return {
      player: "seazn", settledAt: settledAtOf(facts), reserve: expectsPlayer(facts, holdUntil, replayParts), liveExpected: expectsLive(facts), holdUntil, replayParts,
      ...hintsOf(facts, now),
    };
  }
  if (facts.has_session || isOver(facts.status)) return EXTERNAL;
  if (!seaznHostedLive()) return EXTERNAL;
  // The fixture's own pick: the same resolver the panel's picker and the phone's start read, so the player appears exactly when
  // Go live would stream to Seazn. Its answer names no kind, so the kind is read off the row it picked. Not over: never settled.
  const pick = await fixtureStreamTarget(sql, { orgId: facts.org_id, fixtureId });
  if (pick === null) return EXTERNAL;
  const [target] = await sql<{ kind: string }[]>`select kind from org_stream_targets where id = ${pick.id}`;
  return target?.kind === "seazn"
    ? { player: "seazn", settledAt: null, reserve: false, liveExpected: false, holdUntil: null, replayParts: [], ...hintsOf(facts, now) }
    : EXTERNAL;
}
