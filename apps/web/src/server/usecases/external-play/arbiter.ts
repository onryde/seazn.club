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
import type postgres from "postgres";
import { feedsNextMatch } from "@/lib/bracket-next-match";
import { sql } from "@/lib/db";
import { doubleWalkoverRefused } from "@/lib/double-walkover-next-match";
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
import type { CameraPolicy } from "@/lib/camera-policy";
import { type BoardgameClockInput } from "@/server/external-play/clock";
import { SHIP1_TIME_CONTROLS } from "@/server/external-play/time-controls";
import { cameraMatchWindow, matchGuardFaults, type MatchTimes } from "@/server/external-play/video/match-window";
import {
  addParticipant,
  ensureMeeting,
  RealtimeKitError,
  removeParticipant,
  type ParticipantToken,
} from "@/server/external-play/video/realtimekit";
import { roundOpenAt } from "@/server/external-play/round-open";
import { EDITOR_ROLES } from "@/lib/types";
import { ARBITER_RESYNC_LIMIT, rateLimit } from "@/lib/rate-limit";
import { decisiveResultFor, gameClocks, turnAfter, type DecisiveEvent } from "@/components/public-site/match-room/room-snapshot";
import { loadOnlinePlayFixture, loadSides, whiteSideOf, type Side } from "./guard";
import { isPlayableFixtureStatus, organiserOverrideVideo } from "./preflight";
import { reconcile, type ReconcileDeps } from "./reconcile";
import { fixturesSeating, isSeatedOn } from "./seated";

// ---------------------------------------------------------------------------
// The round in view
// ---------------------------------------------------------------------------

type BoardRow = {
  fixtureId: string;
  fixtureNo: number | null;
  /** `fixtures.seq_in_round`, NOT NULL in the schema: every board has its own number (M4, T16 fix round 1 — the old
   *  `i + 1` fallback numbered across rounds, and could never run). */
  seq: number;
  roundNo: number | null;
  stageName: string;
  fixtureStatus: string;
  homeEntrantId: string;
  awayEntrantId: string;
  bridgeStatus: string | null;
  needsReason: string | null;
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
  /** D19's inputs: the stage kind and the two feed edges. */
  stageKind: string | null;
  winnerToFixture: string | null;
  loserToFixture: string | null;
};

type FlagRow = {
  id: string;
  fixtureId: string;
  kind: string;
  personId: string | null;
  openedAt: Date;
  note: string | null;
};

/** What `?fixture=` asked for (I3): that board's round, or a plain "not
 *  here" — never a different board. T16's "Review in arbiter panel" link
 *  depends on it.
 *  - `round`: the board is this club's, in THIS division, paired, not
 *    cancelled, in a round that was opened — an earlier round included;
 *  - `own`: all of that, but the viewer plays on it (C1, D7);
 *  - `unavailable`: anything else — an unknown or malformed id, another
 *    club's or division's board, a round never opened, a cancelled board. */
export type ArbiterRequest = { kind: "round"; stageId: string; roundNo: number } | { kind: "unavailable" } | { kind: "own" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function arbiterRequestedRound(auth: AuthCtx, divisionId: string, fixtureId: string): Promise<ArbiterRequest> {
  // A query-string value: a malformed id is "not here", never a 500 from
  // Postgres' uuid cast.
  if (!UUID.test(fixtureId)) return { kind: "unavailable" };
  const [row] = await sql<{ stageId: string; roundNo: number }[]>`
    select f.stage_id as "stageId", f.round_no as "roundNo"
      from fixtures f
     where f.id = ${fixtureId} and f.org_id = ${auth.orgId} and f.division_id = ${divisionId}
       and f.home_entrant_id is not null and f.away_entrant_id is not null
       and f.status <> 'cancelled'
       and exists (select 1 from stage_round_opens o where o.stage_id = f.stage_id and o.round_no = f.round_no)`;
  if (!row) return { kind: "unavailable" };
  if (auth.userId !== null && (await isSeatedOn(auth.userId, fixtureId))) return { kind: "own" };
  return { kind: "round", stageId: row.stageId, roundNo: row.roundNo };
}

/** The division's most recently OPENED round (D12) — or, with `round`, that
 *  opened round of this division (I3's `?fixture=`) — its boards in board
 *  order (fixtures.seq_in_round — the room's boardNo), each with its state,
 *  clocks and flags. null ⇒ no such round has been opened: the panel's empty
 *  state, never a refusal. */
export async function loadArbiterRound(
  auth: AuthCtx,
  divisionId: string,
  opts: { round?: { stageId: string; roundNo: number } } = {},
): Promise<ArbiterRound | null> {
  const [division] = await sql<{ config: { clock?: BoardgameClockInput } | null }[]>`
    select d.config from divisions d
      join competitions c on c.id = d.competition_id
     where d.id = ${divisionId} and c.org_id = ${auth.orgId}`;
  if (!division) throw new HttpError(404, "division not found", "NOT_FOUND");

  const opened = (pin?: { stageId: string; roundNo: number }) => sql<{ stageId: string; stageName: string; roundNo: number }[]>`
    select o.stage_id as "stageId", s.name as "stageName", o.round_no as "roundNo"
      from stage_round_opens o
      join stages s on s.id = o.stage_id
     where s.division_id = ${divisionId} and o.org_id = ${auth.orgId}
       ${pin ? sql`and o.stage_id = ${pin.stageId} and o.round_no = ${pin.roundNo}` : sql``}
     order by o.opened_at desc, o.round_no desc
     limit 1`;
  const [latest] = await opened();
  const [round] = opts.round ? await opened(opts.round) : [latest];
  if (!round) return null;
  // N1: a pinned round is current only when it IS the most recently opened
  // one — the module's contract above — so the panel can say otherwise.
  const current = latest !== undefined && latest.stageId === round.stageId && latest.roundNo === round.roundNo;

  const rows = await boardRows(auth, sql`f.stage_id = ${round.stageId} and f.round_no = ${round.roundNo}`, { cancelled: false });

  const clock = division.config?.clock;
  const timeControl =
    SHIP1_TIME_CONTROLS.find(
      (tc) => clock !== undefined && tc.limitSeconds === clock.base && tc.incrementSeconds === (clock.increment ?? 0) && clock.delay === undefined,
    )?.key ?? null;
  const limitMs = (clock?.base ?? 0) * 1_000;

  // One stage, one policy (stage → division → competition): every board of
  // the round shares it.
  const policy = rows.length > 0 ? await fixtureCameraPolicy(rows[0]!.fixtureId) : "off";

  const flagRows = await openFlagRows(auth, rows.map((r) => r.fixtureId));

  // C1 (D7): a board the viewer plays on is never listed — not watchable,
  // not offered, not joined. Counted, so the panel can say why it is missing.
  const own = auth.userId === null ? new Set<string>() : await fixturesSeating(auth.userId, rows.map((r) => r.fixtureId));

  // M4: every board is read at once (its sides, its colours, its result, its
  // flags) — never one board after another. Promise.all keeps board order.
  const listed = [...rows.entries()].filter(([, r]) => !own.has(r.fixtureId));
  const boards: ArbiterBoard[] = await Promise.all(
    listed.map(([, r]) => boardOf(auth, r, { limitMs, policy, flagRows })),
  );
  return { stageId: round.stageId, stageName: round.stageName, roundNo: round.roundNo, timeControl, boards, ownBoards: own.size, current };
}

/** A board with open flags, wherever it sits in the division (T16's
 *  organiser queue, "Flagged · the game carried on"). */
export type FlaggedBoard = ArbiterBoard & { roundNo: number | null; stageName: string };

/**
 * The division's boards with OPEN flags — any round, any state: a camera
 * report lands after the game, so a finished board is the usual case. Never
 * a board the viewer plays on (C1, D7: the panel's own rule); those are
 * counted, so the queue can say why one is missing. Evidence only — nothing
 * here decides anything (D10).
 */
export async function listFlaggedExternalPlay(
  auth: AuthCtx,
  divisionId: string,
): Promise<{ boards: FlaggedBoard[]; ownBoards: number }> {
  const [division] = await sql<{ config: { clock?: BoardgameClockInput } | null }[]>`
    select d.config from divisions d
      join competitions c on c.id = d.competition_id
     where d.id = ${divisionId} and c.org_id = ${auth.orgId}`;
  if (!division) throw new HttpError(404, "division not found", "NOT_FOUND");

  const [flagged] = await sql<{ ids: string[] }[]>`
    select coalesce(array_agg(distinct fl.fixture_id), '{}') as ids
      from fixture_play_flags fl
      join fixtures f on f.id = fl.fixture_id
     where f.division_id = ${divisionId} and fl.org_id = ${auth.orgId} and fl.closed_at is null`;
  const ids = flagged?.ids ?? [];
  if (ids.length === 0) return { boards: [], ownBoards: 0 };

  // R4: a cancelled board's open flags are listed too — still the organiser's to review and close.
  const rows = await boardRows(auth, sql`f.id in ${sql(ids)}`, { cancelled: true });
  const own = auth.userId === null ? new Set<string>() : await fixturesSeating(auth.userId, rows.map((r) => r.fixtureId));
  const listed = rows.filter((r) => !own.has(r.fixtureId));
  const flagRows = await openFlagRows(auth, listed.map((r) => r.fixtureId));
  const limitMs = (division.config?.clock?.base ?? 0) * 1_000;
  const boards = await Promise.all(
    listed.map(async (r): Promise<FlaggedBoard> => {
      const policy = await fixtureCameraPolicy(r.fixtureId);
      const board = await boardOf(auth, r, { limitMs, policy, flagRows });
      return { ...board, roundNo: r.roundNo, stageName: r.stageName };
    }),
  );
  return { boards, ownBoards: rows.length - listed.length };
}

/** The board columns both readers paint from — the round in view and the
 *  division's flagged boards (T16) — so a board reads the same in both.
 *  `cancelled`: the Flagged list keeps a cancelled board (R4, its flags are
 *  still to review); the round in view does not. */
function boardRows(auth: AuthCtx, where: postgres.Fragment, opts: { cancelled: boolean }) {
  return sql<BoardRow[]>`
    select f.id as "fixtureId", f.fixture_no as "fixtureNo", f.seq_in_round as "seq",
           f.round_no as "roundNo", s.name as "stageName",
           f.status as "fixtureStatus",
           f.home_entrant_id as "homeEntrantId", f.away_entrant_id as "awayEntrantId",
           ep.status as "bridgeStatus", ep.needs_reason as "needsReason", ep.challenge_id as "challengeId", ep.white_side as "whiteSide",
           ep.move_count as "moveCount", ep.white_ms as "whiteMs", ep.black_ms as "blackMs",
           ep.last_move_at as "lastMoveAt", ep.started_at as "startedAt", ep.finished_at as "finishedAt",
           ep.game_over_at as "gameOverAt", ep.video_override_at as "overrideAt",
           m.fixture_id is not null as "hasMeeting", m.ended_at as "meetingEndedAt",
           m.camera_evidence_at as "evidenceAt",
           s.kind as "stageKind", f.winner_to_fixture as "winnerToFixture", f.loser_to_fixture as "loserToFixture"
      from fixtures f
      join stages s on s.id = f.stage_id
      left join fixture_external_play ep on ep.fixture_id = f.id
      left join fixture_video_meetings m on m.fixture_id = f.id
     where ${where}
       and f.org_id = ${auth.orgId}
       and f.home_entrant_id is not null and f.away_entrant_id is not null
       ${opts.cancelled ? sql`` : sql`and f.status <> 'cancelled'`}
     order by f.round_no nulls last, f.seq_in_round nulls last, f.id`;
}

/** The boards' OPEN flags: a flag the organiser closed ("Let the game go
 *  on", T16) has had its review; the row stays on file as the record. */
function openFlagRows(auth: AuthCtx, fixtureIds: readonly string[]): Promise<FlagRow[]> {
  if (fixtureIds.length === 0) return Promise.resolve([]);
  return sql<FlagRow[]>`
    select id, fixture_id as "fixtureId", kind, person_id as "personId", opened_at as "openedAt", note
      from fixture_play_flags
     where fixture_id in ${sql([...fixtureIds])} and org_id = ${auth.orgId}
       and closed_at is null
     order by opened_at, id`;
}

/** One board as the panel paints it: its sides, its colours, its state, its
 *  clocks and its open flags. */
async function boardOf(
  auth: AuthCtx,
  r: BoardRow,
  ctx: { limitMs: number; policy: CameraPolicy; flagRows: readonly FlagRow[] },
): Promise<ArbiterBoard> {
  const { limitMs, policy, flagRows } = ctx;
  const [sides, whiteSide] = await Promise.all([
    loadSides(r),
    r.whiteSide ?? whiteSideOf({ fixtureId: r.fixtureId, orgId: auth.orgId }),
  ] as const);
  const white = whiteSide === "home" ? sides.home : sides.away;
  const black = whiteSide === "home" ? sides.away : sides.home;
  const over = r.bridgeStatus === "finished" || r.gameOverAt !== null;
  const playable = isPlayableFixtureStatus(r.fixtureStatus) && r.bridgeStatus !== "finished";
  const gameOnFile = r.challengeId !== null;

  let state: ArbiterBoardState;
  if (r.fixtureStatus === "cancelled") {
    state = { kind: "cancelled" };
  } else if (!isPlayableFixtureStatus(r.fixtureStatus) || r.bridgeStatus === "finished") {
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
  const flags: ArbiterFlag[] = await Promise.all(
    flagRows.filter((x) => x.fixtureId === r.fixtureId).map((f) => flagView(f, { nameOf, times: r })),
  );

  return {
    fixtureId: r.fixtureId,
    fixtureNo: r.fixtureNo,
    boardNo: r.seq,
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
    canSettle: playable && r.bridgeStatus !== null,
    whiteSide,
    tiebreakOwed: r.bridgeStatus === "needs_organiser" && r.needsReason === "tiebreak_owed",
    // W2b D19 — the append guard's own reading, so the settle never offers a No result the server refuses.
    noNextMatch: doubleWalkoverRefused(r.stageKind, feedsNextMatch({ winner_to_fixture: r.winnerToFixture, loser_to_fixture: r.loserToFixture })),
    flags,
  };
}

async function flagView(
  f: FlagRow,
  ctx: { nameOf: (personId: string | null) => string | null; times: MatchTimes },
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
        windowFrom: ctx.times.startedAt?.toISOString() ?? null,
      };
    case "camera_connection_problems": {
      // The guard's own stamps are the authority, never the note's number
      // (controller addendum 2026-10-12), over job 5's OWN window through
      // job 5's own function (T15 fix round 1, I1): what the panel shows is
      // what the sweep judged. No window (no first move on file now, or a
      // person-less row): no number at all, never a made-up one.
      const window = cameraMatchWindow(ctx.times);
      if (window.kind !== "window" || f.personId === null) {
        return { id: f.id, kind: "camera_connection_problems", at, personName: ctx.nameOf(f.personId), seconds: null, stamps: null };
      }
      const { stamped } = await matchGuardFaults(sql, { fixtureId: f.fixtureId, personId: f.personId, window });
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
      // V439's CHECK names exactly three kinds. A guard, not a comment: a
      // fourth is refused loudly rather than drawn as one of the three.
      throw new HttpError(500, `fixture_play_flags row with unknown kind ${JSON.stringify(f.kind)}`, "FLAG_KIND_UNKNOWN");
  }
}

/** The recorded result, White first ("1–0"), as the engine folds it — from the event that decided the board: a
 *  boardgame.result or (W2b spec §5.2) a core.forfeit — or null when neither is on the ledger (a settled board
 *  without a result). */
async function scoreOf(r: BoardRow, whiteEntrantId: string, blackEntrantId: string): Promise<string | null> {
  const [row] = await sql<DecisiveEvent[]>`
    select e.type, e.payload from score_events e
     where e.fixture_id = ${r.fixtureId} and e.type in ('boardgame.result', 'core.forfeit')
       and not exists (select 1 from score_events v where v.voids_event_id = e.id)
     order by e.seq desc limit 1`;
  if (!row) return null;
  return decisiveResultFor(row, { myEntrantId: whiteEntrantId, opponentEntrantId: blackEntrantId, myColour: "white" })?.score ?? null;
}

// ---------------------------------------------------------------------------
// The receive-only join
// ---------------------------------------------------------------------------

export type ArbiterVideo = {
  ensureMeeting: (fixtureId: string) => Promise<{ meetingId: string }>;
  addParticipant: (a: { meetingId: string; subject: string; preset: "player" | "arbiter" }) => Promise<ParticipantToken>;
  removeParticipant: (a: { meetingId: string; participantId: string }) => Promise<void>;
};

export const REAL_ARBITER_VIDEO: ArbiterVideo = {
  ensureMeeting: (fixtureId) => ensureMeeting(fixtureId),
  addParticipant: (a) => addParticipant(a),
  removeParticipant: (a) => removeParticipant(a),
};

/** What the arbiter's browser gets: ITS OWN token for a participant made for
 *  this open alone (`participantId`, which it hands back on leaving), and
 *  which player participants are White and Black (their peers' `userId`).
 *  Never a player's token (spec §10). */
export type ArbiterJoin = { authToken: string; participantId: string; white: string[]; black: string[] };

/** The roles that may watch a board — the route's `write` (requireOrgAuth:
 *  owner or admin), and the role the sweep's arbiter removal keeps. One list,
 *  so a join never mints what the next pass would remove. */
export function mayWatchBoards(role: string | null): boolean {
  return role !== null && (EDITOR_ROLES as readonly string[]).includes(role);
}

function requireWatcher(auth: AuthCtx): string {
  if (auth.via !== "session" || auth.userId === null) {
    throw new HttpError(403, "Watching a board needs a signed-in organiser", "ARBITER_NEEDS_SESSION");
  }
  // The route already asks for an owner or admin; this is the assumption as a
  // guard, so the usecase cannot be reached by a weaker door.
  if (!mayWatchBoards(auth.role)) {
    throw new HttpError(403, "Only a club owner or admin watches a board", "ARBITER_NOT_ORGANISER");
  }
  return auth.userId;
}

/**
 * One organiser joins one board's meeting receive-only (preset `arbiter`:
 * produces nothing, sees at most two video streams). The meeting is the
 * players' own — ensureMeeting is idempotent per fixture, so an arbiter who
 * arrives first creates the one both players will join, and an ended meeting
 * is never re-made (its 409 passes through). Authorisation is the route's
 * (requireResourceAuth on the fixture, write: owner or admin); this adds that
 * the caller is a signed-in person — a key or a scoring device has no
 * business watching a player's camera — who does not play on the board (C1),
 * on a board still being played in an opened round (M2).
 *
 * Every open mints a FRESH participant (I2): a RealtimeKit token lasts 100
 * days and a token refresh does not revoke the old one, so a reused
 * participant would keep every token ever handed out alive. The server
 * removes it — leaveAsArbiter when the panel closes, the sweep when the role
 * is gone or ARBITER_PARTICIPANT_TTL_MS has passed, endMeeting at teardown.
 */
export async function joinAsArbiter(
  auth: AuthCtx,
  fixtureId: string,
  deps: { video?: ArbiterVideo } = {},
): Promise<ArbiterJoin> {
  const userId = requireWatcher(auth);
  const f = await loadOnlinePlayFixture(fixtureId);
  if (f === null || f.orgId !== auth.orgId) throw new HttpError(404, "fixture not found", "NOT_FOUND");
  // C1 (D7 safeguarding): a player never watches their opponent's camera,
  // and an organiser who plays on this board is its player. Refused before
  // any meeting is made or participant minted.
  if (await isSeatedOn(userId, fixtureId)) {
    throw new HttpError(403, "You play on this board, so another organiser must watch it", "ARBITER_PLAYS_THIS_BOARD");
  }
  // M2: a board that is over, or whose round was never opened, has no
  // match to watch — and ensureMeeting would make a room for it.
  if (!isPlayableFixtureStatus(f.fixtureStatus) || f.bridge?.status === "finished") {
    throw new HttpError(409, "this board can no longer be played", "FIXTURE_NOT_PLAYABLE");
  }
  const [pos] = await sql<{ stageId: string; roundNo: number }[]>`
    select stage_id as "stageId", round_no as "roundNo" from fixtures where id = ${fixtureId}`;
  if (!pos || !(await roundOpenAt(sql, pos.stageId, pos.roundNo))) {
    throw new HttpError(409, "this board's round is not open yet", "ROUND_NOT_OPEN");
  }
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

  const video = deps.video ?? REAL_ARBITER_VIDEO;
  let token: ParticipantToken;
  try {
    const { meetingId } = await video.ensureMeeting(fixtureId);
    token = await mintArbiter({ fixtureId, userId, meetingId }, video);
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
    participantId: token.participantId,
    white: players.filter((p) => p.personId === white.personId).map((p) => p.participantId),
    black: players.filter((p) => p.personId === black.personId).map((p) => p.participantId),
  };
}

/** A fresh arbiter participant for this open, on file before its token is
 *  handed out. A record that cannot be written leaves no participant behind:
 *  it is removed at the vendor at once, so nothing watches untracked. */
async function mintArbiter(
  a: { fixtureId: string; userId: string; meetingId: string },
  video: ArbiterVideo,
): Promise<ParticipantToken> {
  // `subject` is RealtimeKit's custom_participant_id: an internal id, never
  // an email or a name (realtimekit.ts addParticipant).
  const minted = await video.addParticipant({ meetingId: a.meetingId, subject: a.userId, preset: "arbiter" });
  try {
    await sql`
      insert into fixture_video_participants (fixture_id, person_id, preset, participant_id, user_id)
      values (${a.fixtureId}, null, 'arbiter', ${minted.participantId}, ${a.userId})`;
  } catch (err) {
    await video.removeParticipant({ meetingId: a.meetingId, participantId: minted.participantId }).catch(() => undefined);
    throw err;
  }
  return minted;
}

/**
 * The panel closed (I2): the caller's OWN arbiter participant on this board
 * is removed at the vendor — kicked from the live session, then deleted, so
 * its token can no longer watch — and the watch's end is stamped. Only the
 * caller's: anything else on this board, or this participant named on
 * another board or club, is the same 404. Already removed (a repeat, the
 * sweep, the teardown) answers `removed: false` without calling the vendor.
 * A vendor failure is a 503 and leaves the watch open for the sweep. A room
 * already torn down is INACTIVE (endMeeting), so nothing can join it: the
 * stamp is all that is left to do.
 */
export async function leaveAsArbiter(
  auth: AuthCtx,
  fixtureId: string,
  participantId: string,
  deps: { video?: ArbiterVideo } = {},
): Promise<{ removed: boolean }> {
  if (auth.via !== "session" || auth.userId === null) {
    throw new HttpError(403, "Watching a board needs a signed-in organiser", "ARBITER_NEEDS_SESSION");
  }
  const [row] = await sql<{ id: string; removedAt: Date | null; meetingId: string; meetingEndedAt: Date | null }[]>`
    select vp.id, vp.removed_at as "removedAt", m.meeting_id as "meetingId", m.ended_at as "meetingEndedAt"
      from fixture_video_participants vp
      join fixtures f on f.id = vp.fixture_id
      join fixture_video_meetings m on m.fixture_id = vp.fixture_id
     where vp.fixture_id = ${fixtureId} and vp.participant_id = ${participantId}
       and vp.preset = 'arbiter' and vp.user_id = ${auth.userId} and f.org_id = ${auth.orgId}`;
  if (!row) throw new HttpError(404, "no such arbiter participant", "NOT_FOUND");
  if (row.removedAt !== null) return { removed: false };
  if (row.meetingEndedAt === null) {
    try {
      await (deps.video ?? REAL_ARBITER_VIDEO).removeParticipant({ meetingId: row.meetingId, participantId });
    } catch (err) {
      if (!(err instanceof RealtimeKitError)) throw err;
      captureError(err, {
        orgId: auth.orgId,
        route: "external-play/arbiter/leave",
        extra: { fixtureId, status: err.status, code: err.code },
      });
      throw new HttpError(503, "video is unavailable right now", "VIDEO_UNAVAILABLE");
    }
  }
  const stamped = await sql`
    update fixture_video_participants set removed_at = now() where id = ${row.id} and removed_at is null`;
  return { removed: stamped.count > 0 };
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

/** "Resync from Lichess": reconcile's `organiser` trigger (design §3.5).
 *  M3: a board that is not played online — over the board, or not this
 *  club's — is the same 404, never a "nothing read". A FINISHED online board
 *  stays resyncable: reconcile closes the bridge of a fixture settled
 *  elsewhere. Throttled per fixture (ARBITER_RESYNC_LIMIT, 429): each read
 *  spends a player's Lichess token. A token that cannot be opened is
 *  reconcile's 503 LICHESS_TOKEN_UNAVAILABLE, passed through. */
export async function resyncExternalPlay(
  auth: AuthCtx,
  fixtureId: string,
  deps: ReconcileDeps = {},
): Promise<{ read: boolean; adopted: number; finished: boolean }> {
  requireSession(auth, "A resync");
  const [row] = await sql<{ orgId: string; online: boolean }[]>`
    select f.org_id as "orgId",
           (d.sport_key = 'boardgame' and coalesce(d.config->>'onlinePlay', 'off') = 'lichess') as online
      from fixtures f join divisions d on d.id = f.division_id
     where f.id = ${fixtureId}`;
  if (!row || row.orgId !== auth.orgId || !row.online) {
    throw new HttpError(404, "no online board here", "NOT_FOUND");
  }
  await rateLimit(`arbiter-resync:${fixtureId}`, ARBITER_RESYNC_LIMIT);
  const out = await reconcile(fixtureId, "organiser", deps);
  return { read: out !== null, adopted: out?.adopted ?? 0, finished: out?.finished ?? false };
}

/** "Let this board play without video" (D11): Task 8's
 *  organiserOverrideVideo, which owns every other refusal
 *  (FIXTURE_NOT_PLAYABLE, VIDEO_NOT_REQUIRED) and the one audit record.
 *
 *  Self-override (coordinator ruling, 2026-10-12): the override excuses the
 *  board's cameras, so an organiser who plays on the board would be excusing
 *  their own — a conflict of interest. C1's shared seated predicate decides,
 *  before anything is written. Resync has no such guard: it only re-reads
 *  Lichess and decides nothing. */
export async function overrideVideoAsOrganiser(
  auth: AuthCtx,
  fixtureId: string,
  note: string,
): Promise<{ overridden: true }> {
  const actorUserId = requireSession(auth, "Letting a board play without video");
  await requireOwnFixture(auth, fixtureId);
  if (await isSeatedOn(actorUserId, fixtureId)) {
    throw new HttpError(403, "You play on this board, so another organiser must decide on its video", "ARBITER_PLAYS_THIS_BOARD");
  }
  await organiserOverrideVideo({ fixtureId, actorUserId, note });
  return { overridden: true };
}
