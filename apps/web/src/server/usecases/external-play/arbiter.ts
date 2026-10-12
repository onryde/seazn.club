import "server-only";
// T15 — the arbiter panel's server halves (chess design §5.3, D8).
//
// There is no arbiter role and no assignment store (spec §12: the existing
// organiser/admin role; D8: deterrent only, no mandatory observer). The
// organiser who opens the panel IS the arbiter, the round in view is the
// division's most recently opened one, and nothing anywhere waits for an
// arbiter to be present.
//
// Every table read here past the org check is SEALED (FORCE RLS, no app_user
// policy): stage_round_opens, fixture_play_flags, fixture_video_meetings,
// fixture_video_participants, fixture_video_guard_faults. They are read with
// the privileged `sql`, and only after the caller's organisation has been
// proven to own the division or fixture.
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { captureError } from "@/lib/sentry";
import {
  boardMoveNo,
  parseCameraLostNote,
  parseOutOfBandNote,
  type ArbiterBoard,
  type ArbiterBoardState,
  type ArbiterFlag,
  type ArbiterRound,
} from "@/lib/arbiter-view";
import type { AuthCtx } from "@/server/api-v1/auth";
import { fixtureCameraPolicy } from "@/server/external-play/camera-policy";
import { type BoardgameClockInput } from "@/server/external-play/clock";
import { SHIP1_TIME_CONTROLS } from "@/server/external-play/time-controls";
import { guardFaultSpans } from "@/server/external-play/video/guard-faults";
import { stampedInMatch } from "@/server/external-play/video/match-camera-off";
import {
  addParticipant,
  ensureMeeting,
  RealtimeKitError,
  refreshParticipantToken,
  type ParticipantToken,
} from "@/server/external-play/video/realtimekit";
import { gameClocks, resultFor, turnAfter } from "@/components/public-site/match-room/room-snapshot";
import { loadOnlinePlayFixture, loadSides, whiteSideOf, type Side } from "./guard";
import { isPlayableFixtureStatus, organiserOverrideVideo } from "./preflight";
import { reconcile, type ReconcileDeps } from "./reconcile";

// ---------------------------------------------------------------------------
// The round in view
// ---------------------------------------------------------------------------

type BoardRow = {
  fixtureId: string;
  fixtureNo: number | null;
  seq: number | null;
  fixtureStatus: string;
  homeEntrantId: string;
  awayEntrantId: string;
  bridgeStatus: string | null;
  challengeId: string | null;
  whiteSide: Side | null;
  moveCount: number | null;
  whiteMs: number | null;
  blackMs: number | null;
  lastMoveAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  gameOverAt: Date | null;
  overrideAt: Date | null;
  hasMeeting: boolean;
  meetingEndedAt: Date | null;
  evidenceAt: Date | null;
};

type FlagRow = {
  id: string;
  fixtureId: string;
  kind: string;
  personId: string | null;
  openedAt: Date;
  note: string | null;
};

/** The division's most recently OPENED round (D12), its boards in board
 *  order (fixtures.seq_in_round — the room's boardNo), each with its state,
 *  clocks and flags. null ⇒ no round of this division has been opened: the
 *  panel's empty state, never a refusal. */
export async function loadArbiterRound(auth: AuthCtx, divisionId: string): Promise<ArbiterRound | null> {
  const [division] = await sql<{ config: { clock?: BoardgameClockInput } | null }[]>`
    select d.config from divisions d
      join competitions c on c.id = d.competition_id
     where d.id = ${divisionId} and c.org_id = ${auth.orgId}`;
  if (!division) throw new HttpError(404, "division not found", "NOT_FOUND");

  const [round] = await sql<{ stageId: string; stageName: string; roundNo: number }[]>`
    select o.stage_id as "stageId", s.name as "stageName", o.round_no as "roundNo"
      from stage_round_opens o
      join stages s on s.id = o.stage_id
     where s.division_id = ${divisionId} and o.org_id = ${auth.orgId}
     order by o.opened_at desc, o.round_no desc
     limit 1`;
  if (!round) return null;

  const rows = await sql<BoardRow[]>`
    select f.id as "fixtureId", f.fixture_no as "fixtureNo", f.seq_in_round as "seq",
           f.status as "fixtureStatus",
           f.home_entrant_id as "homeEntrantId", f.away_entrant_id as "awayEntrantId",
           ep.status as "bridgeStatus", ep.challenge_id as "challengeId", ep.white_side as "whiteSide",
           ep.move_count as "moveCount", ep.white_ms as "whiteMs", ep.black_ms as "blackMs",
           ep.last_move_at as "lastMoveAt", ep.started_at as "startedAt", ep.finished_at as "finishedAt",
           ep.game_over_at as "gameOverAt", ep.video_override_at as "overrideAt",
           m.fixture_id is not null as "hasMeeting", m.ended_at as "meetingEndedAt",
           m.camera_evidence_at as "evidenceAt"
      from fixtures f
      left join fixture_external_play ep on ep.fixture_id = f.id
      left join fixture_video_meetings m on m.fixture_id = f.id
     where f.stage_id = ${round.stageId} and f.round_no = ${round.roundNo}
       and f.org_id = ${auth.orgId}
       and f.home_entrant_id is not null and f.away_entrant_id is not null
       and f.status <> 'cancelled'
     order by f.seq_in_round nulls last, f.id`;

  const clock = division.config?.clock;
  const timeControl =
    SHIP1_TIME_CONTROLS.find(
      (tc) => clock !== undefined && tc.limitSeconds === clock.base && tc.incrementSeconds === (clock.increment ?? 0) && clock.delay === undefined,
    )?.key ?? null;
  const limitMs = (clock?.base ?? 0) * 1_000;

  // One stage, one policy (stage → division → competition): every board of
  // the round shares it.
  const policy = rows.length > 0 ? await fixtureCameraPolicy(rows[0]!.fixtureId) : "off";

  const flagRows =
    rows.length === 0
      ? []
      : await sql<FlagRow[]>`
          select id, fixture_id as "fixtureId", kind, person_id as "personId", opened_at as "openedAt", note
            from fixture_play_flags
           where fixture_id in ${sql(rows.map((r) => r.fixtureId))} and org_id = ${auth.orgId}
           order by opened_at, id`;

  const boards: ArbiterBoard[] = [];
  for (const [i, r] of rows.entries()) {
    const sides = await loadSides(r);
    const whiteSide: Side = r.whiteSide ?? (await whiteSideOf({ fixtureId: r.fixtureId, orgId: auth.orgId }));
    const white = whiteSide === "home" ? sides.home : sides.away;
    const black = whiteSide === "home" ? sides.away : sides.home;
    const over = r.bridgeStatus === "finished" || r.gameOverAt !== null;
    const playable = isPlayableFixtureStatus(r.fixtureStatus) && r.bridgeStatus !== "finished";
    const gameOnFile = r.challengeId !== null;

    let state: ArbiterBoardState;
    if (!isPlayableFixtureStatus(r.fixtureStatus) || r.bridgeStatus === "finished") {
      state = { kind: "result", score: await scoreOf(r, white.entrantId, black.entrantId) };
    } else if (r.bridgeStatus === "needs_organiser") {
      state = { kind: "on_hold" };
    } else if (!gameOnFile) {
      state = { kind: "checking_in" };
    } else if ((r.moveCount ?? 0) === 0) {
      state = { kind: "starting" };
    } else {
      state = { kind: "live", moveNo: boardMoveNo(r.moveCount ?? 0) };
    }

    const clocks = gameOnFile
      ? gameClocks({
          limitMs,
          whiteMs: r.whiteMs,
          blackMs: r.blackMs,
          lastMoveAt: r.lastMoveAt,
          moveCount: r.moveCount ?? 0,
          over,
        })
      : null;

    const nameOf = (personId: string | null): string | null =>
      personId === null ? null : personId === white.personId ? white.displayName : personId === black.personId ? black.displayName : null;
    const gameEnd = r.finishedAt ?? r.gameOverAt ?? r.meetingEndedAt ?? new Date();
    const flags: ArbiterFlag[] = [];
    for (const f of flagRows.filter((x) => x.fixtureId === r.fixtureId)) {
      flags.push(await flagView(f, { nameOf, startedAt: r.startedAt, gameEnd }));
    }

    boards.push({
      fixtureId: r.fixtureId,
      fixtureNo: r.fixtureNo,
      boardNo: r.seq ?? i + 1,
      white: { name: white.displayName, personId: white.personId },
      black: { name: black.displayName, personId: black.personId },
      state,
      clock:
        clocks === null
          ? null
          : {
              whiteMs: clocks.whiteMs,
              blackMs: clocks.blackMs,
              asOf: clocks.clockAsOf,
              running: clocks.clockRunning,
              turn: turnAfter(r.moveCount ?? 0),
            },
      cameraPolicy: policy,
      videoOverridden: r.overrideAt !== null,
      cameraReport:
        policy === "required" && r.startedAt !== null && r.overrideAt === null
          ? r.evidenceAt !== null
            ? "settled"
            : "pending"
          : null,
      canResync: gameOnFile && playable && r.bridgeStatus !== null && ["ready", "live", "needs_organiser"].includes(r.bridgeStatus),
      playable,
      flags,
    });
  }
  return { stageId: round.stageId, stageName: round.stageName, roundNo: round.roundNo, timeControl, boards };
}

async function flagView(
  f: FlagRow,
  ctx: { nameOf: (personId: string | null) => string | null; startedAt: Date | null; gameEnd: Date },
): Promise<ArbiterFlag> {
  const at = f.openedAt.toISOString();
  switch (f.kind) {
    case "out_of_band_play":
      return { id: f.id, kind: "out_of_band_play", at, plies: parseOutOfBandNote(f.note) };
    case "camera_lost":
      return {
        id: f.id,
        kind: "camera_lost",
        at,
        personName: ctx.nameOf(f.personId),
        report: parseCameraLostNote(f.note),
        windowFrom: ctx.startedAt?.toISOString() ?? null,
      };
    case "camera_connection_problems": {
      // The guard's own stamps are the authority, never the note's number
      // (controller addendum 2026-10-12): the same window arithmetic the
      // sweep's job 5 used to decide to tell the organiser.
      const spans =
        f.personId === null ? [] : await guardFaultSpans(sql, { fixtureId: f.fixtureId, personId: f.personId });
      const from = ctx.startedAt ?? ctx.gameEnd;
      const window = { from, to: new Date(Math.max(from.getTime(), ctx.gameEnd.getTime())) };
      const stamped = stampedInMatch(
        window,
        spans.map((s) => ({ from: s.from, to: s.to ?? new Date(Math.max(s.from.getTime(), window.to.getTime())) })),
      );
      return {
        id: f.id,
        kind: "camera_connection_problems",
        at,
        personName: ctx.nameOf(f.personId),
        seconds: Math.round(stamped.seconds),
        stamps: stamped.stamps,
      };
    }
    default:
      // V433's CHECK names exactly three kinds. A guard, not a comment: a
      // fourth is refused loudly rather than drawn as one of the three.
      throw new HttpError(500, `fixture_play_flags row with unknown kind ${JSON.stringify(f.kind)}`, "FLAG_KIND_UNKNOWN");
  }
}

/** The recorded result, White first ("1–0"), as the engine folds it — or
 *  null when none is on the ledger (a settled board without a result). */
async function scoreOf(r: BoardRow, whiteEntrantId: string, blackEntrantId: string): Promise<string | null> {
  const [row] = await sql<{ payload: { winner?: string | null; method?: string } }[]>`
    select e.payload from score_events e
     where e.fixture_id = ${r.fixtureId} and e.type = 'boardgame.result'
       and not exists (select 1 from score_events v where v.voids_event_id = e.id)
     order by e.seq desc limit 1`;
  if (!row) return null;
  return (
    resultFor({
      winnerEntrantId: row.payload.winner ?? null,
      method: row.payload.method ?? null,
      myEntrantId: whiteEntrantId,
      opponentEntrantId: blackEntrantId,
      myColour: "white",
    })?.score ?? null
  );
}

// ---------------------------------------------------------------------------
// The receive-only join
// ---------------------------------------------------------------------------

export type ArbiterVideo = {
  ensureMeeting: (fixtureId: string) => Promise<{ meetingId: string }>;
  addParticipant: (a: { meetingId: string; subject: string; preset: "player" | "arbiter" }) => Promise<ParticipantToken>;
  refreshParticipantToken: (a: { meetingId: string; participantId: string }) => Promise<ParticipantToken>;
};

const REAL_VIDEO: ArbiterVideo = {
  ensureMeeting: (fixtureId) => ensureMeeting(fixtureId),
  addParticipant: (a) => addParticipant(a),
  refreshParticipantToken: (a) => refreshParticipantToken(a),
};

/** What the arbiter's browser gets: ITS OWN token, and which player
 *  participants are White and Black (their peers' `userId`). Never a player's
 *  token (spec §10). */
export type ArbiterJoin = { authToken: string; white: string[]; black: string[] };

/**
 * One organiser joins one board's meeting receive-only (preset `arbiter`:
 * produces nothing, sees at most two video streams). The meeting is the
 * players' own — ensureMeeting is idempotent per fixture, so an arbiter who
 * arrives first creates the one both players will join, and an ended meeting
 * is never re-made (its 409 passes through). Authorisation is the route's
 * (requireResourceAuth on the fixture, write); this adds that the caller is a
 * signed-in person — a key or a scoring device has no business watching a
 * player's camera.
 */
export async function joinAsArbiter(
  auth: AuthCtx,
  fixtureId: string,
  deps: { video?: ArbiterVideo } = {},
): Promise<ArbiterJoin> {
  if (auth.via !== "session" || auth.userId === null) {
    throw new HttpError(403, "Watching a board needs a signed-in organiser", "ARBITER_NEEDS_SESSION");
  }
  const userId = auth.userId;
  const f = await loadOnlinePlayFixture(fixtureId);
  if (f === null || f.orgId !== auth.orgId) throw new HttpError(404, "fixture not found", "NOT_FOUND");
  if ((await fixtureCameraPolicy(fixtureId)) === "off") {
    throw new HttpError(409, "this board plays without cameras", "VIDEO_NOT_IN_USE");
  }
  // D11's stamp is read from the row itself: it is not on the guard's bridge
  // (preflight reads it the same way, before any RealtimeKit call).
  const [override] = await sql<{ at: Date | null }[]>`
    select video_override_at as at from fixture_external_play where fixture_id = ${fixtureId}`;
  if (override?.at) {
    throw new HttpError(409, "this board was let play without video", "VIDEO_OVERRIDDEN");
  }

  const video = deps.video ?? REAL_VIDEO;
  let token: ParticipantToken;
  try {
    const { meetingId } = await video.ensureMeeting(fixtureId);
    token = await arbiterToken({ fixtureId, userId, meetingId }, video);
  } catch (err) {
    if (!(err instanceof RealtimeKitError)) throw err;
    captureError(err, {
      orgId: f.orgId,
      route: "external-play/arbiter",
      extra: { fixtureId, status: err.status, code: err.code },
    });
    throw new HttpError(503, "video is unavailable right now", "VIDEO_UNAVAILABLE");
  }

  const sides = await loadSides(f);
  const whiteSide = f.bridge?.white_side ?? (await whiteSideOf(f));
  const white = whiteSide === "home" ? sides.home : sides.away;
  const black = whiteSide === "home" ? sides.away : sides.home;
  const people = [white.personId, black.personId].filter((p): p is string => p !== null);
  const players =
    people.length === 0
      ? []
      : await sql<{ personId: string; participantId: string }[]>`
          select person_id as "personId", participant_id as "participantId"
            from fixture_video_participants
           where fixture_id = ${fixtureId} and preset = 'player' and person_id in ${sql(people)}
           order by created_at, id`;
  return {
    authToken: token.authToken,
    white: players.filter((p) => p.personId === white.personId).map((p) => p.participantId),
    black: players.filter((p) => p.personId === black.personId).map((p) => p.participantId),
  };
}

/** The organiser's ONE arbiter participant on this fixture: refreshed when on
 *  file, else minted and kept — the player path's shape (preflight.ts
 *  issuePlayerToken), with V436's partial unique index as the race's judge. */
async function arbiterToken(
  a: { fixtureId: string; userId: string; meetingId: string },
  video: ArbiterVideo,
): Promise<ParticipantToken> {
  const stored = await storedArbiter(a);
  if (stored) return video.refreshParticipantToken({ meetingId: a.meetingId, participantId: stored });
  // `subject` is RealtimeKit's custom_participant_id: an internal id, never
  // an email or a name (realtimekit.ts addParticipant).
  const minted = await video.addParticipant({ meetingId: a.meetingId, subject: a.userId, preset: "arbiter" });
  const inserted = await sql<{ participant_id: string }[]>`
    insert into fixture_video_participants (fixture_id, person_id, preset, participant_id, user_id)
    values (${a.fixtureId}, null, 'arbiter', ${minted.participantId}, ${a.userId})
    on conflict (fixture_id, user_id) where preset = 'arbiter' and user_id is not null do nothing
    returning participant_id`;
  if (inserted.length > 0) return minted;
  const winner = await storedArbiter(a);
  if (!winner) throw new HttpError(500, "arbiter participant vanished mid-race", "ARBITER_PARTICIPANT_LOST");
  return video.refreshParticipantToken({ meetingId: a.meetingId, participantId: winner });
}

async function storedArbiter(a: { fixtureId: string; userId: string }): Promise<string | null> {
  const [row] = await sql<{ participant_id: string }[]>`
    select participant_id from fixture_video_participants
     where fixture_id = ${a.fixtureId} and preset = 'arbiter' and user_id = ${a.userId}
     limit 1`;
  return row?.participant_id ?? null;
}

// ---------------------------------------------------------------------------
// The organiser's two decision actions that have a usecase (T15 brief
// addendum: map to existing usecases; T16 was named the owner of these two
// routes and now consumes them).
// ---------------------------------------------------------------------------

function requireSession(auth: AuthCtx, what: string): string {
  if (auth.via !== "session" || auth.userId === null) {
    throw new HttpError(403, `${what} needs a signed-in organiser`, "ORGANISER_SESSION_REQUIRED");
  }
  return auth.userId;
}

async function requireOwnFixture(auth: AuthCtx, fixtureId: string): Promise<void> {
  const [row] = await sql<{ org_id: string }[]>`select org_id from fixtures where id = ${fixtureId}`;
  if (!row || row.org_id !== auth.orgId) throw new HttpError(404, "fixture not found", "NOT_FOUND");
}

/** "Resync from Lichess": reconcile's `organiser` trigger (design §3.5). */
export async function resyncExternalPlay(
  auth: AuthCtx,
  fixtureId: string,
  deps: ReconcileDeps = {},
): Promise<{ read: boolean; adopted: number; finished: boolean }> {
  requireSession(auth, "A resync");
  await requireOwnFixture(auth, fixtureId);
  const out = await reconcile(fixtureId, "organiser", deps);
  return { read: out !== null, adopted: out?.adopted ?? 0, finished: out?.finished ?? false };
}

/** "Let this board play without video" (D11): Task 8's
 *  organiserOverrideVideo, which owns every refusal (FIXTURE_NOT_PLAYABLE,
 *  VIDEO_NOT_REQUIRED) and the one audit record. */
export async function overrideVideoAsOrganiser(
  auth: AuthCtx,
  fixtureId: string,
  note: string,
): Promise<{ overridden: true }> {
  const actorUserId = requireSession(auth, "Letting a board play without video");
  await requireOwnFixture(auth, fixtureId);
  await organiserOverrideVideo({ fixtureId, actorUserId, note });
  return { overridden: true };
}
