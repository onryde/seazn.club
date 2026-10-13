import "server-only";
// The seat (spec §5.2, §3.2). A player is seated only when the MEETING
// reports them present in a live session — never on anything the client
// sends. The POC gated check-in on a client-supplied camera boolean; that is
// forgeable and is on the do-not-copy list (§10). There is no parameter here
// a browser could set.
//
// D12: the window hangs off `stage_round_opens.opened_at` (read through
// round-open.ts, the one reader of the stamp), not `fixtures.scheduled_at`.
// "The window has not started" is its OWN refusal (`round_not_open`), not
// `window_closed`: the room says different things about the two.
import type postgres from "postgres";
import { roomPhase } from "@/server/external-play/window";
import { roundOpenFor } from "@/server/external-play/round-open";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { captureError } from "@/lib/sentry";
import { fixtureCameraPolicy } from "@/server/external-play/camera-policy";
import type { GrantRefusal } from "@/server/external-play/types";
import { assertLichessConsentForPlay } from "../external-accounts";
import {
  RealtimeKitError,
  addParticipant,
  ensureMeeting,
  hasLiveVideoPublisher,
  refreshParticipantToken,
  type ParticipantToken,
} from "@/server/external-play/video/realtimekit";
import {
  effectiveBridge,
  ensureBridgeRow,
  loadOnlinePlayFixture,
  loadSides,
  type OnlinePlayFixture,
  type SidePlayer,
} from "./guard";

/** Every reason a seat can be refused. The two camera refusals carry the
 *  caller's OWN participant token (controller ruling Q1, 2026-10-09): under
 *  `required` a player becomes live only by joining the meeting, so the token
 *  to join with must reach them BEFORE they are seated — a refusal that
 *  carried none would leave no way to ever be seated. Every other refusal
 *  carries nothing. */
export const SEAT_REFUSAL_REASONS = [
  "camera_required",
  "camera_lost",
  "window_closed",
  "not_a_player",
  "round_not_open",
  "fixture_not_playable",
  "video_unavailable",
  // Fix round 2 (controller ruling): T2's play gate, asked by the seat.
  "lichess_link_required",
  "lichess_reconsent_required",
] as const;

/** The two seat refusals T2's play gate can produce — declared in the
 *  import-free external-play/types.ts (review I6), re-exported here. */
export type { GrantRefusal };

export type SeatResult =
  | { seated: true; participant: ParticipantToken | null }
  | { seated: false; reason: "camera_required" | "camera_lost"; participant: ParticipantToken }
  | {
      seated: false;
      reason:
        | "window_closed"
        | "not_a_player"
        | "round_not_open"
        | "fixture_not_playable"
        | "video_unavailable"
        | GrantRefusal;
    };

type Video = {
  ensureMeeting: typeof ensureMeeting;
  addParticipant: typeof addParticipant;
  hasLiveVideoPublisher: typeof hasLiveVideoPublisher;
  refreshParticipantToken: typeof refreshParticipantToken;
};

/** Test seam only — T9 and the room pass no deps. */
export type PreflightDeps = {
  now?: Date;
  video?: Video;
};

const REAL_VIDEO: Video = { ensureMeeting, addParticipant, hasLiveVideoPublisher, refreshParticipantToken };

/** T2's assertLichessConsentForPlay as a seat reason: its two 422s map to
 *  `lichess_link_required` / `lichess_reconsent_required` (the codes T14's
 *  re-link screen is drawn on); anything else — a 503
 *  LICHESS_TOKEN_UNAVAILABLE, a database error — is not a consent refusal and
 *  propagates. T9 reuses it, so creation names the same two reasons. */
export async function playGrantRefusal(userId: string | null): Promise<GrantRefusal | null> {
  try {
    await assertLichessConsentForPlay(userId);
    return null;
  } catch (err) {
    if (err instanceof HttpError && err.code === "LICHESS_LINK_REQUIRED") return "lichess_link_required";
    if (err instanceof HttpError && err.code === "LICHESS_RECONSENT_REQUIRED") return "lichess_reconsent_required";
    throw err;
  }
}

/** Controller ruling Q2 (2026-10-09): a board is playable only while it is
 *  `scheduled` or `in_play`. A withdrawal leaves it `abandoned` (league
 *  expunge, measured) or walked over, and `loadOnlinePlayFixture` still loads
 *  those settled-open statuses because spectator and room views must — so the
 *  SEAT refuses them here, and T9 reuses this when a create leaves the queue. */
export function isPlayableFixtureStatus(status: string): boolean {
  return status === "scheduled" || status === "in_play";
}

export async function seatPlayer(
  a: { fixtureId: string; personId: string },
  deps: PreflightDeps = {},
): Promise<SeatResult> {
  const now = deps.now ?? new Date();

  const f = await loadOnlinePlayFixture(a.fixtureId);
  // A fixture we do not serve and a caller who is not one of the two players
  // collapse to the SAME answer, so a probe cannot learn which check failed
  // (the same rule readMatchRoom follows, room.ts).
  if (!f) return { seated: false, reason: "not_a_player" };

  const { home, away } = await loadSides(f);
  const player: SidePlayer | undefined = [home, away].find((s) => s.personId === a.personId);
  // An empty side has `personId: null`; a null smuggled in as the caller's id
  // would otherwise "match" it.
  if (!player || player.personId === null) return { seated: false, reason: "not_a_player" };

  // Only now, to a confirmed player: a withdrawn or walked-over board.
  if (!isPlayableFixtureStatus(f.fixtureStatus)) return { seated: false, reason: "fixture_not_playable" };

  const open = await roundOpenFor(sql, a.fixtureId);
  if (!open) return { seated: false, reason: "round_not_open" };
  const phase = roomPhase(now, open.roundOpenedAt);
  // "before" is a stamp more than T−10 in the future: the window has not
  // started, which is the round_not_open story, never "closed".
  if (phase === "before") return { seated: false, reason: "round_not_open" };
  // T+20 is the deadline to be seated and have the game created, not a cap on
  // the game (spec §3.6): a seated player reloading mid-game comes back in.
  if (phase === "closed" && !isReentry(f, player)) return { seated: false, reason: "window_closed" };

  // T2's play gate (fix round 2, controller ruling): AFTER the checks above —
  // a board that cannot be played, a round not open or a window closed are
  // not cured by re-linking, so they answer first — and BEFORE any token is
  // minted, under EVERY camera policy (`off` seats with no video at all). A
  // seat is a promise that T9 can create the game and this player can move.
  const refused = await playGrantRefusal(player.userId);
  if (refused) return { seated: false, reason: refused };

  const policy = await fixtureCameraPolicy(a.fixtureId);
  if (policy === "off") {
    // No meeting is created. Zero video spend (spec §5.1).
    return { seated: true, participant: null };
  }

  // D11: an organiser has already proceeded without video on this fixture.
  // Read BEFORE any RealtimeKit call, because the whole point of the override
  // is that RealtimeKit may be the thing that is broken. It relaxes only the
  // camera: every refusal above still stands.
  const [bridge] = await sql<{ video_override_at: Date | null }[]>`
    select video_override_at from fixture_external_play where fixture_id = ${a.fixtureId}`;
  if (bridge?.video_override_at) return { seated: true, participant: null };

  const video = deps.video ?? REAL_VIDEO;
  if (policy === "optional") {
    // Shown if the player grants camera; NEVER blocks a seat — not even when
    // RealtimeKit is down. The publisher is deliberately not asked: a question
    // whose answer is ignored is how a later refactor turns `optional` into
    // `required`.
    try {
      const meeting = await video.ensureMeeting(a.fixtureId);
      return { seated: true, participant: await issuePlayerToken(a, meeting.meetingId, video) };
    } catch (err) {
      if (!(err instanceof RealtimeKitError)) throw err;
      reportOutage(err, f.orgId, a.fixtureId, policy);
      return { seated: true, participant: null };
    }
  }

  try {
    return await verifyRequiredSeat(a, now, video);
  } catch (err) {
    // An outage (or an answer the adapter cannot read — T7 THROWS on those)
    // is the vendor's failure, never the player's camera: it is its own
    // reason, so neither the player nor the organiser is told "camera off",
    // and the organiser's D11 override is the way through. Anything that is
    // not a RealtimeKit failure (VIDEO_MEETING_ENDED, a database error)
    // propagates unchanged.
    if (!(err instanceof RealtimeKitError)) throw err;
    reportOutage(err, f.orgId, a.fixtureId, policy);
    return { seated: false, reason: "video_unavailable" };
  }
}

/** Controller ruling I1 (fix round 1, amending Q1): after the window, a
 *  caller passes the window check only when ALL THREE hold. Every other check
 *  before and after it still applies — the camera included.
 *
 *  (a) they were seated on this fixture. Seats are re-verified on every claim
 *      and never stored as a pass (T9: "not a stored stamp"), so the durable
 *      record of a seat is the game T9 created immediately after seating both
 *      players through seatPlayer: it names the two Lichess accounts it seated,
 *      by colour. The caller's own account must be the one recorded for THEIR
 *      colour. This holds under every policy — Off and an overridden Required
 *      seat leave no video row at all, so a video row cannot be the record.
 *  (b) the game exists: T9 records the Lichess game id exactly when it
 *      creates one. A stale bridge (minted for an older timetable and never
 *      live) is not this fixture's game (`effectiveBridge`).
 *  (c) the game is not over (amended, fix round 2): that bridge is `ready`
 *      (T9's create + accept) or `live` (T10's first accepted move).
 *      `finished` and `needs_organiser` refuse. NOT `fixtures.status`: an
 *      online board stays `scheduled` for the whole game — `in_play` comes
 *      only from `core.start`, which T12 emits as it writes the result — and
 *      a board settled since is refused earlier as fixture_not_playable. */
function isReentry(f: OnlinePlayFixture, player: SidePlayer): boolean {
  const game = effectiveBridge(f);
  if (game === null || game.challenge_id === null) return false; // (b)
  if (game.status !== "ready" && game.status !== "live") return false; // (c)
  if (game.white_side === null || player.lichess === null) return false; // (a)
  const seatedAccount = game.white_side === player.side ? game.white_lichess_id : game.black_lichess_id;
  return seatedAccount === player.lichess.id; // (a)
}

/** `required`: seated only when the meeting reports this participant joined to
 *  a live session and not left (T7 hasLiveVideoPublisher; camera-on itself is
 *  the preset's job). Re-asked on EVERY claim, which is what makes seatPlayer
 *  the freshness check T9 runs immediately before creating a game. */
async function verifyRequiredSeat(
  a: { fixtureId: string; personId: string },
  now: Date,
  video: Video,
): Promise<SeatResult> {
  const meeting = await video.ensureMeeting(a.fixtureId);
  const participant = await issuePlayerToken(a, meeting.meetingId, video);
  const [prior] = await sql<{ last_publisher_seen_at: Date | null }[]>`
    select last_publisher_seen_at from fixture_video_participants
     where fixture_id = ${a.fixtureId} and participant_id = ${participant.participantId}`;
  const live = await video.hasLiveVideoPublisher({
    meetingId: meeting.meetingId,
    participantId: participant.participantId,
  });
  if (live) {
    await sql`
      update fixture_video_participants set last_publisher_seen_at = ${now}
       where fixture_id = ${a.fixtureId} and participant_id = ${participant.participantId}`;
    return { seated: true, participant };
  }
  // `last_publisher_seen_at` is EVIDENCE — when this participant was last
  // verified live — and never a pass: nothing seats on it (every claim above
  // re-asks the meeting) and nothing clears it. Clearing it on a loss (the
  // brief's design) made a repeat claim with the camera still off answer
  // camera_required, telling a player who HAD passed that they never had.
  const hadPassed = prior?.last_publisher_seen_at != null;
  return { seated: false, reason: hadPassed ? "camera_lost" : "camera_required", participant };
}

/** THE one place a player's RealtimeKit token is issued — so the
 *  reuse-versus-regenerate policy lives here and nowhere else.
 *
 *  ONE participant per player per fixture: the first claim mints it (its
 *  token comes with it); every later claim — a reload, a second tab, T9's
 *  freshness check — REGENERATES a token for that same participant, so peer
 *  discovery stays on one `user_id`. Measured 2026-10-09
 *  (rtk-token-regen.log): a regenerated token is a different JWT and does not
 *  invalidate the earlier one, so a second tab does not knock out the first.
 *  Tokens are never stored: a token at rest is a token to leak.
 *
 *  (fixture_id, person_id) is deliberately NOT unique (V439: a second camera
 *  angle is config, not a migration), so two first claims racing (two tabs)
 *  are serialised on the meeting row instead: mint OUTSIDE any transaction
 *  (an open transaction across an HTTP call holds the lock for the round
 *  trip), then, under a short `for update` on the meeting row, store ours
 *  only if nobody stored one first. The loser's minted participant is never
 *  stored and never handed out; the loser gets a token for the winner's. */
async function issuePlayerToken(
  a: { fixtureId: string; personId: string },
  meetingId: string,
  video: Video,
): Promise<ParticipantToken> {
  const stored = await storedPlayerParticipant(sql, a);
  if (stored) return video.refreshParticipantToken({ meetingId, participantId: stored });

  const minted = await video.addParticipant({ meetingId, subject: a.personId, preset: "player" });
  const kept = await sql.begin(async (tx) => {
    await tx`select fixture_id from fixture_video_meetings where fixture_id = ${a.fixtureId} for update`;
    const winner = await storedPlayerParticipant(tx, a);
    if (winner) return winner;
    await tx`
      insert into fixture_video_participants (fixture_id, person_id, preset, participant_id)
      values (${a.fixtureId}, ${a.personId}, 'player', ${minted.participantId})`;
    return minted.participantId;
  });
  if (kept === minted.participantId) return minted;
  return video.refreshParticipantToken({ meetingId, participantId: kept });
}

// The privileged client or one of its transactions (the round-open.ts shape).
type AnySql = postgres.TransactionSql | postgres.Sql;

async function storedPlayerParticipant(
  db: AnySql,
  a: { fixtureId: string; personId: string },
): Promise<string | null> {
  const [row] = await db<{ participant_id: string }[]>`
    select participant_id from fixture_video_participants
     where fixture_id = ${a.fixtureId} and person_id = ${a.personId} and preset = 'player'
     order by created_at, id
     limit 1`;
  return row?.participant_id ?? null;
}

/** A RealtimeKit failure the seat absorbs (as video_unavailable, or as no
 *  tile under `optional`) is still reported — never swallowed silently. The
 *  adapter's messages never carry a token or a response body (T7). */
function reportOutage(err: RealtimeKitError, orgId: string, fixtureId: string, policy: string): void {
  captureError(err, {
    orgId,
    route: "external-play/preflight",
    extra: { fixtureId, policy, status: err.status, code: err.code },
  });
}

/** D11. RealtimeKit unavailable under `required`: an organiser may proceed
 *  without video on one fixture, and the record says who did and why. A video
 *  vendor outage must not cancel a tournament — and must not be silent.
 *
 *  ONE record (controller addendum 2): `fixture_external_play.video_override_at`
 *  is what the seat reads; the who and why live only in `online_chess_audit`
 *  (kind `video_override`), never also in competition_events. Both are written
 *  in one transaction, so a stamp never exists without its record.
 *
 *  Idempotent and FIRST-WRITER-WINS: the reason on the record is the one given
 *  when the decision was actually taken, not whatever a later click re-sent.
 *
 *  Authorisation is the CALLER's: the organiser route (T16) resolves
 *  `actorUserId` from an authorised session. This function trusts it. */
export async function organiserOverrideVideo(a: {
  fixtureId: string;
  actorUserId: string;
  note: string;
}): Promise<void> {
  const note = a.note.trim();
  if (note === "") {
    throw new HttpError(422, "an override needs a reason", "OVERRIDE_NOTE_REQUIRED");
  }
  const f = await loadOnlinePlayFixture(a.fixtureId);
  if (!f) throw new HttpError(404, "fixture not found", "NOT_FOUND");
  // The override exists for ONE situation: video required, RealtimeKit down,
  // on a board still being played. Anywhere else it would be a "proceeded
  // without video" record for a board that never needed video, or is over.
  // Both refusals come before anything is written.
  if (!isPlayableFixtureStatus(f.fixtureStatus)) {
    throw new HttpError(409, "this match can no longer be played", "FIXTURE_NOT_PLAYABLE");
  }
  if ((await fixtureCameraPolicy(a.fixtureId)) !== "required") {
    throw new HttpError(409, "video is not required for this match", "VIDEO_NOT_REQUIRED");
  }
  // Before the open, exactly as on a timed board (review M3): a board with no
  // start time has no basis yet, so its row is minted on a provisional one
  // that the open rebases (invite.ts attachToOpen).
  await ensureBridgeRow(f, { basisIfUnopened: new Date() });
  await sql.begin(async (tx) => {
    // Lock order: the fixture BEFORE the bridge row — the order every seat
    // clear and rebuild takes (stages.ts lockBoardsRefusingOnlineGames). The
    // audit insert below takes KEY SHARE on the fixture; with the bridge row
    // locked first, a clear holding the fixture would deadlock this.
    await tx`select id from fixtures where id = ${a.fixtureId} for share`;
    const claimed = await tx<{ fixture_id: string }[]>`
      update fixture_external_play
         set video_override_at = now(), updated_at = now()
       where fixture_id = ${a.fixtureId} and video_override_at is null
       returning fixture_id`;
    if (claimed.length === 0) return; // already overridden — the first record stands
    await tx`
      insert into online_chess_audit (org_id, fixture_id, kind, actor_user_id, note)
      values (${f.orgId}, ${a.fixtureId}, 'video_override', ${a.actorUserId}, ${note})`;
  });
}
