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
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { captureError } from "@/lib/sentry";
import {
  boardMoveNo,
  parseCameraLostNote,
  parseMultipleDevicesNote,
  parseOutOfBandNote,
  type ArbiterBoard,
  type ArbiterBoardState,
  type ArbiterFlag,
  type ArbiterRound,
  type ArbiterSeatCheckin,
  type ArbiterSideMeeting,
} from "@/lib/arbiter-view";
import { seatInviteWords, type SeatInviteWord } from "@/lib/invite-status";
import type { AuthCtx } from "@/server/api-v1/auth";
import { fixtureCameraPolicy } from "@/server/external-play/camera-policy";
import type { CameraPolicy } from "@/lib/camera-policy";
import { type BoardgameClockInput } from "@/server/external-play/clock";
import { SHIP1_TIME_CONTROLS } from "@/server/external-play/time-controls";
import { cameraMatchWindow, matchGuardFaults, type MatchTimes } from "@/server/external-play/video/match-window";
import {
  addParticipant,
  RealtimeKitDeferred,
  RealtimeKitError,
  removeParticipant,
  type ParticipantToken,
} from "@/server/external-play/video/realtimekit";
import { anchorOfRow, boardExtraSql, boardRankSql, roundOpenAt } from "@/server/external-play/round-open";
import { type BoardAnchor, bridgeGameOnFile, checkInCounts, extendRefusal, extensionsLeft, windowFor } from "@/server/external-play/window";
import { latestEmailStatus, type EmailStatusRow } from "@/server/email-outbox/status";
import type { CheckinExtendState } from "@/lib/checkin-extend";
import { EDITOR_ROLES } from "@/lib/types";
import { ARBITER_JOIN_LIMIT, ARBITER_RESYNC_LIMIT, rateLimit } from "@/lib/rate-limit";
import { log } from "@/server/logger";
import { decisiveResultFor, gameClocks, turnAfter, type DecisiveEvent } from "@/components/public-site/match-room/room-snapshot";
import { checkedInAtOfBoards } from "./check-ins";
import { loadOnlinePlayFixture, loadSides, whiteSideOf, type Side, type SidePlayer } from "./guard";
import { noResultOffer } from "./no-result";
import { readNeedsReason } from "./queue";
import { isPlayableFixtureStatus, organiserOverrideVideo } from "./preflight";
import { reconcile, type ReconcileDeps } from "./reconcile";
import { CHESS_SEAT_REF_TYPE, chessSeatRef, seatStampBound, type Colour } from "./seat-stamp";
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
  /** The facts that make a game "on file" beside the challenge (a sent create, a live mint claim): `bridgeGameOnFile`. */
  createSentAt: Date | null;
  mintClaimedAt: Date | null;
  /** The board's round open (null: the round was never opened) and its place in it, for the check-in extension's reading
   *  (spec §3.2.2): the stamp, the stored `staggered` flag, the zero-based rank and the board's extension so far. */
  openedAt: Date | null;
  staggered: boolean | null;
  rank: number;
  extraMs: number;
  extensions: number;
  /** Phase 2 (spec §6): the seat stamps and the open they are bound to (`seatStampBound`'s inputs). `openId` is the board's own
   *  round open (`stage_round_opens.id`, null when the round was never opened); `roundOpenId` is the one the bridge row's stamps
   *  name, which differs after a fixture moved between rounds. */
  whiteEmailedAt: Date | null;
  blackEmailedAt: Date | null;
  roundOpenId: string | null;
  openId: string | null;
  whiteSide: Side | null;
  moveCount: number | null;
  whiteMs: number | null;
  blackMs: number | null;
  lastMoveAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  gameOverAt: Date | null;
  overrideAt: Date | null;
  /** D16: each player's meeting as the board's own join reads it (§5.6.4) - `Row` is whether a row is on file for the side,
   *  `SamePair` whether it was made for the board's CURRENT pairing (a row an earlier pairing left is no meeting). */
  homeRow: boolean;
  homeSamePair: boolean;
  homeEndedAt: Date | null;
  homeEvidenceAt: Date | null;
  awayRow: boolean;
  awaySamePair: boolean;
  awayEndedAt: Date | null;
  awayEvidenceAt: Date | null;
  /** I-3: what the settle offers in place of a winner is read from the stage kind, the hold and the line's two feed
   *  edges (no-result.ts). */
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
  opts: { round?: { stageId: string; roundNo: number }; now?: Date } = {},
): Promise<ArbiterRound | null> {
  const now = opts.now ?? new Date();
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
  // Pass 1 (C24): the boards, exactly as the Flagged list builds them, each with the two sides it resolved.
  const built = await Promise.all(
    listed.map(async ([, r]) => ({ row: r, ...(await boardWithSides(auth, r, { limitMs, policy, flagRows, now })) })),
  );
  // Pass 2: the seats of the boards in check-in, from ONE read of the round's check-ins and ONE of its invite mail.
  const boards = await withSeats(auth, built);
  return {
    stageId: round.stageId,
    stageName: round.stageName,
    roundNo: round.roundNo,
    timeControl,
    boards,
    ownBoards: own.size,
    current,
    extendableBoards: boards.filter((b) => b.checkin?.canExtend === true).length,
  };
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
      const board = await boardOf(auth, r, { limitMs, policy, flagRows, now: null });
      return { ...board, roundNo: r.roundNo, stageName: r.stageName };
    }),
  );
  return { boards, ownBoards: rows.length - listed.length };
}

/** The board columns both readers paint from — the round in view and the
 *  division's flagged boards (T16) — so a board reads the same in both.
 *  D16: a board has up to TWO meeting rows (one per player) and is listed ONCE - each side is its own join on
 *  `(fixture_id, side)`, so the facts of the two rows stay apart (a single left join would list the board twice and
 *  fold two rows' facts into one).
 *  `cancelled`: the Flagged list keeps a cancelled board (R4, its flags are
 *  still to review); the round in view does not. */
function boardRows(auth: AuthCtx, where: postgres.Fragment, opts: { cancelled: boolean }) {
  return sql<BoardRow[]>`
    select f.id as "fixtureId", f.fixture_no as "fixtureNo", f.seq_in_round as "seq",
           f.round_no as "roundNo", s.name as "stageName",
           f.status as "fixtureStatus",
           f.home_entrant_id as "homeEntrantId", f.away_entrant_id as "awayEntrantId",
           ep.status as "bridgeStatus", ep.needs_reason as "needsReason", ep.challenge_id as "challengeId", ep.white_side as "whiteSide",
           ep.create_sent_at as "createSentAt", ep.mint_claimed_at as "mintClaimedAt",
           o.opened_at as "openedAt", o.staggered, ${boardRankSql(sql)} as rank, ${boardExtraSql(sql)} as "extraMs",
           coalesce(ep.checkin_extensions, 0)::int as extensions,
           ep.white_emailed_at as "whiteEmailedAt", ep.black_emailed_at as "blackEmailedAt",
           ep.round_open_id as "roundOpenId", o.id as "openId",
           ep.move_count as "moveCount", ep.white_ms as "whiteMs", ep.black_ms as "blackMs",
           ep.last_move_at as "lastMoveAt", ep.started_at as "startedAt", ep.finished_at as "finishedAt",
           ep.game_over_at as "gameOverAt", ep.video_override_at as "overrideAt",
           mh.fixture_id is not null as "homeRow",
           (mh.home_entrant_id, mh.away_entrant_id) is not distinct from (f.home_entrant_id, f.away_entrant_id) as "homeSamePair",
           mh.ended_at as "homeEndedAt", mh.camera_evidence_at as "homeEvidenceAt",
           ma.fixture_id is not null as "awayRow",
           (ma.home_entrant_id, ma.away_entrant_id) is not distinct from (f.home_entrant_id, f.away_entrant_id) as "awaySamePair",
           ma.ended_at as "awayEndedAt", ma.camera_evidence_at as "awayEvidenceAt",
           s.kind as "stageKind", f.winner_to_fixture as "winnerToFixture", f.loser_to_fixture as "loserToFixture"
      from fixtures f
      join stages s on s.id = f.stage_id
      left join fixture_external_play ep on ep.fixture_id = f.id
      left join stage_round_opens o on o.stage_id = f.stage_id and o.round_no = f.round_no
      left join fixture_video_meetings mh on mh.fixture_id = f.id and mh.side = 'home'
      left join fixture_video_meetings ma on ma.fixture_id = f.id and ma.side = 'away'
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

/** One side's meeting as the board list reads it (D16, §5.6.4): none (no row, or one an earlier pairing left), open or
 *  ended - with that row's own end and evidence stamps. */
function sideMeeting(row: boolean, samePair: boolean, endedAt: Date | null, evidenceAt: Date | null): ArbiterSideMeeting {
  if (!row || !samePair) return { state: "none", endedAt: null, evidenceAt: null };
  return {
    state: endedAt === null ? "open" : "ended",
    endedAt: endedAt?.toISOString() ?? null,
    evidenceAt: evidenceAt?.toISOString() ?? null,
  };
}

/** The board's camera report from its two rows (D16, §5.6.4), stating each count's answer instead of letting an empty set
 *  read as done:
 *  - no row at all: nothing is on file to report and nothing to wait for - null (a drop left such boards behind, and they
 *    must not read "pending" for ever);
 *  - a row on file that is not stamped: pending;
 *  - settled ONLY with two rows, both stamped;
 *  - exactly ONE row: an anomaly (a game needs both players seated, so both rows) - pending, and said so in the log. */
function cameraReportOf(fixtureId: string, sides: { home: ArbiterSideMeeting; away: ArbiterSideMeeting }): "pending" | "settled" | null {
  const rows = [sides.home, sides.away].filter((x) => x.state !== "none");
  if (rows.length === 0) return null;
  if (rows.length === 1) {
    log.warn({ fixtureId }, "arbiter: a started Required board has one camera meeting, not two; its camera report reads pending");
    return "pending";
  }
  return rows.every((x) => x.evidenceAt !== null) ? "settled" : "pending";
}

/** One board as the panel paints it: its sides, its colours, its state, its
 *  clocks and its open flags. `seats` is null here: the round view fills it in a second pass over the boards in check-in
 *  (`withSeats`), and the Flagged list never does. */
async function boardOf(
  auth: AuthCtx,
  r: BoardRow,
  ctx: { limitMs: number; policy: CameraPolicy; flagRows: readonly FlagRow[]; now: Date | null },
): Promise<ArbiterBoard> {
  return (await boardWithSides(auth, r, ctx)).board;
}

/** `boardOf`, with the two sides it resolved by COLOUR kept: the second pass needs each seat's person (for the check-in) and its
 *  mailboxes (for the invite words), and re-reading them per board would undo M4's single read. */
async function boardWithSides(
  auth: AuthCtx,
  r: BoardRow,
  ctx: { limitMs: number; policy: CameraPolicy; flagRows: readonly FlagRow[]; now: Date | null },
): Promise<{ board: ArbiterBoard; white: SidePlayer; black: SidePlayer }> {
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
  } else if (r.fixtureStatus === "abandoned") {
    // I-3: an abandon decides nobody (the engine folds it to no outcome — the fixture reads `abandoned` until a
    // settle, if any, decides it): No result, with no score to show.
    state = { kind: "result", score: null, noResult: true };
  } else if (!isPlayableFixtureStatus(r.fixtureStatus) || r.bridgeStatus === "finished") {
    state = { kind: "result", score: await scoreOf(r, white.entrantId, black.entrantId), noResult: false };
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
  const meetings = {
    home: sideMeeting(r.homeRow, r.homeSamePair, r.homeEndedAt, r.homeEvidenceAt),
    away: sideMeeting(r.awayRow, r.awaySamePair, r.awayEndedAt, r.awayEvidenceAt),
  };
  // §5.6.4: a flag's window is its OWN player's row - the sweep judged each player over their own meeting's end, and the
  // panel must show what job 5 judged. A flag whose player has no row (or no side on this board) is judged on the game's
  // end alone.
  const sideOf = (personId: string | null): Side | null =>
    personId === null ? null : personId === sides.home.personId ? "home" : personId === sides.away.personId ? "away" : null;
  const flags: ArbiterFlag[] = await Promise.all(
    flagRows
      .filter((x) => x.fixtureId === r.fixtureId)
      .map((f) => {
        const side = sideOf(f.personId);
        const endedAt = side === null ? null : side === "home" ? (r.homeSamePair ? r.homeEndedAt : null) : r.awaySamePair ? r.awayEndedAt : null;
        return flagView(f, { nameOf, side, times: { ...r, meetingEndedAt: endedAt } });
      }),
  );

  const board: ArbiterBoard = {
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
    cameraReport: policy === "required" && r.startedAt !== null && r.overrideAt === null ? cameraReportOf(r.fixtureId, meetings) : null,
    sides: meetings,
    canResync: gameOnFile && playable && r.bridgeStatus !== null && ["ready", "live", "needs_organiser"].includes(r.bridgeStatus),
    playable,
    canSettle: playable && r.bridgeStatus !== null,
    whiteSide,
    tiebreakOwed: r.bridgeStatus === "needs_organiser" && r.needsReason === "tiebreak_owed",
    // I-3 — the settle's own reading (no-result.ts), so the panel never offers a No result the server refuses.
    noResultOffer: noResultOffer({
      stageKind: r.stageKind,
      reason: r.needsReason === null ? null : readNeedsReason(r.needsReason),
      edges: { winner_to_fixture: r.winnerToFixture, loser_to_fixture: r.loserToFixture },
    }),
    checkin: ctx.now === null ? null : checkinOf(r, ctx.now),
    seats: null,
    flags,
  };
  return { board, white, black };
}

/** The board's check-in anchor (window.ts): where its window sits, with its extension. null for a board whose round was never opened. */
function anchorOf(r: BoardRow): BoardAnchor | null {
  if (r.openedAt === null) return null;
  return anchorOfRow({ openedAt: r.openedAt, rank: r.rank, staggered: r.staggered === true, extraMs: r.extraMs });
}

const COLOURS = ["white", "black"] as const satisfies readonly Colour[];

/**
 * Pass 2 of the round view (spec §6.2, C24): attach `seats` to the boards in check-in. The round's boards are read in one go and the
 * outbox is read once for every seat of them; a round with no board in check-in issues no outbox read at all. A board in any other
 * state keeps `seats: null`.
 *
 * Per seat, `here` is `checkInCounts` (window.ts, the rule's one authority) over the person's recorded check-in against the board's
 * own window, and `invites` is `seatInviteWords` over the seat's mail, its CURRENT mailboxes (`SidePlayer.recipients`, raw: the words
 * fold both sides) and whether the seat holds a stamp bound to the open on screen (`seatStampBound`, the one rule).
 */
async function withSeats(
  auth: AuthCtx,
  built: readonly { row: BoardRow; board: ArbiterBoard; white: SidePlayer; black: SidePlayer }[],
): Promise<ArbiterBoard[]> {
  // A board whose round was never opened has no window to be here in, so it takes no seats, like the `checkin` it also lacks. It
  // cannot be on screen (the round is chosen from `stage_round_opens` and the board joins that same row, which no product writer
  // deletes; a stage's deletion takes its fixtures with it), so this is a guard and not a branch: if it ever fires the seats stay
  // null, and we say so. Unreachable from a real seed, hence no test.
  const inCheckIn = built.flatMap((b) => {
    if (b.board.state.kind !== "checking_in") return [];
    const anchor = anchorOf(b.row);
    if (anchor === null) {
      log.warn({ fixtureId: b.row.fixtureId }, "arbiter: a board in check-in has no round open to anchor its window; its seats stay unread");
      return [];
    }
    return [{ ...b, anchor }];
  });
  if (inCheckIn.length === 0) return built.map((b) => b.board);

  const ids = inCheckIn.map((b) => b.row.fixtureId);
  const [checkedInAt, mail] = await Promise.all([
    checkedInAtOfBoards(ids),
    // Only the chess invite writes a seat ref today, but the outbox is shared: a row of another kind on the same ref and mailbox would
    // become the seat's "latest" and paint its word (final review m4). The hook that holds and releases the stamp reads the same kind.
    latestEmailStatus(auth.orgId, CHESS_SEAT_REF_TYPE, ids.flatMap((id) => COLOURS.map((c) => chessSeatRef(id, c))), "chess_invite"),
  ]);
  // The read orders by ref then lower(recipient), not by time, and keeps two rows that fold to one mailbox only when they differ in
  // padding. `seatInviteWords` lets the LATER row of a mailbox answer, so each seat's rows go in oldest first (ruling M2).
  const rowsByRef = new Map<string, EmailStatusRow[]>();
  for (const row of mail) {
    const list = rowsByRef.get(row.refId);
    if (list) list.push(row);
    else rowsByRef.set(row.refId, [row]);
  }
  for (const list of rowsByRef.values()) list.sort((a, b) => a.at.getTime() - b.at.getTime());

  const seatsOf = new Map<string, NonNullable<ArbiterBoard["seats"]>>();
  for (const { row, anchor, white, black } of inCheckIn) {
    const seat = (colour: Colour, side: SidePlayer): ArbiterSeatCheckin => {
      const refId = chessSeatRef(row.fixtureId, colour);
      const rows = rowsByRef.get(refId) ?? [];
      const stamped = seatStampBound(row, row.openId, colour);
      // A held stamp with no mail at all is an anomaly (the stamp is released when every row ends badly, and a stamped seat was
      // queued with a row): say so, and the seat reads "Not delivered". Scoped to a ref with NO rows on purpose: a stamped seat whose
      // only rows are a PREVIOUS player's mailbox (a player swapped after the invite) is reachable in normal use, reads "Not delivered"
      // quietly, and would otherwise log a warning on every refresh of the panel.
      if (stamped && rows.length === 0) {
        log.warn({ fixtureId: row.fixtureId, colour, refId }, "arbiter: a seat is stamped for this open but has no invite mail on file; it reads Not delivered");
      }
      const at = side.personId === null ? null : (checkedInAt.get(row.fixtureId)?.get(side.personId) ?? null);
      let invites: SeatInviteWord[];
      try {
        invites = seatInviteWords({ rows, mailboxes: side.recipients.map((x) => x.email), stamped });
      } catch {
        // One row the panel has no word for (a status outside the outbox's declared set) must not fail the whole panel. The line
        // names the board, the seat, the ref and the statuses on file: never an address.
        log.error(
          { fixtureId: row.fixtureId, colour, refId, statuses: rows.map((x) => x.status) },
          "arbiter: an invite row has an outbox status with no word; the seat shows no invite words",
        );
        invites = [];
      }
      return { here: checkInCounts(at, anchor), invites };
    };
    seatsOf.set(row.fixtureId, { white: seat("white", white), black: seat("black", black) });
  }
  return built.map((b) => {
    const seats = seatsOf.get(b.row.fixtureId);
    return seats === undefined ? b.board : { ...b.board, seats };
  });
}

/** Spec §3.2.2: one board's check-in as the panel reads it - the deadline it is on (window.ts, with the board's own extension),
 *  how many presses it has left, and whether a press would be accepted NOW: `extendRefusal`, the same rule the door asks, so the
 *  panel never offers a press the server refuses. null for a board whose round was never opened (no window to extend). */
function checkinOf(r: BoardRow, now: Date): CheckinExtendState | null {
  const anchor = anchorOf(r);
  if (anchor === null) return null;
  const refusal = extendRefusal({
    now,
    anchor,
    extensions: r.extensions,
    playable: isPlayableFixtureStatus(r.fixtureStatus) && r.bridgeStatus !== "finished",
    gameOnFile: bridgeGameOnFile(
      { status: r.bridgeStatus ?? "pending", challengeId: r.challengeId, createSentAt: r.createSentAt, mintClaimedAt: r.mintClaimedAt },
      now,
    ),
  });
  const w = windowFor(anchor);
  return {
    canExtend: refusal === null,
    refusal,
    extensionsLeft: extensionsLeft(r.extensions),
    opensAt: w.opensAt.toISOString(),
    deadlineAt: w.deadline.toISOString(),
  };
}

async function flagView(
  f: FlagRow,
  ctx: { nameOf: (personId: string | null) => string | null; side: Side | null; times: MatchTimes },
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
      if (window.kind !== "window" || f.personId === null || ctx.side === null) {
        return { id: f.id, kind: "camera_connection_problems", at, personName: ctx.nameOf(f.personId), seconds: null, stamps: null };
      }
      const { stamped } = await matchGuardFaults(sql, { fixtureId: f.fixtureId, side: ctx.side, personId: f.personId, window });
      return {
        id: f.id,
        kind: "camera_connection_problems",
        at,
        personName: ctx.nameOf(f.personId),
        seconds: Math.round(stamped.seconds),
        stamps: stamped.stamps,
      };
    }
    case "multiple_devices":
      // T17B fix 2, D9: read from job 5's note, strictly (a note it cannot
      // read is null, and the card says so in general words).
      return { id: f.id, kind: "multiple_devices", at, personName: ctx.nameOf(f.personId), report: parseMultipleDevicesNote(f.note) };
    default:
      // V451's CHECK (widened by V455) names exactly four kinds. A guard, not
      // a comment: a fifth is refused loudly rather than drawn as one of them.
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
  addParticipant: (a: { meetingId: string; subject: string; preset: "player" | "arbiter" }) => Promise<ParticipantToken>;
  removeParticipant: (a: { meetingId: string; participantId: string }) => Promise<void>;
};

export const REAL_ARBITER_VIDEO: ArbiterVideo = {
  addParticipant: (a) => addParticipant(a),
  removeParticipant: (a) => removeParticipant(a),
};

/** What the arbiter's browser gets: ITS OWN token for a participant made for
 *  this open alone (`participantId`, which it hands back on leaving), the side
 *  it joined, and the participant ids of the PLAYERS in that meeting (their
 *  peers' `userId` - one, though the model allows more; D16, §5.6.4: a meeting
 *  holds one player, so there are no longer White and Black lists).
 *  Never a player's token (spec §10). */
export type ArbiterJoin = { authToken: string; participantId: string; side: Side; players: string[] };

/** The roles that may watch a board — the route's `write` (requireOrgAuth:
 *  owner or admin), and the role the sweep's arbiter removal keeps. One list,
 *  so a join never mints what the next pass would remove. */
export function mayWatchBoards(role: string | null): boolean {
  return role !== null && (EDITOR_ROLES as readonly string[]).includes(role);
}

export function requireWatcher(auth: AuthCtx): string {
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
 * One organiser joins ONE PLAYER's meeting receive-only (preset `arbiter`: produces nothing, sees at most two video
 * streams). D16 (§5.6.4): a board has a meeting per player, so the request names the side (`ArbiterJoinInput`) and this
 * joins that side's EXISTING meeting or refuses - it never creates one, so an arbiter who arrives before a player makes no
 * room for them to join and spends no create call: 409 VIDEO_MEETING_NOT_STARTED when the side has no meeting for the
 * board's current pairing, 409 VIDEO_MEETING_ENDED when it has ended. Authorisation is the route's
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
 * Throttled per fixture and organiser (ARBITER_JOIN_LIMIT, 429): every flip of the panel's switch is one of these.
 */
export async function joinAsArbiter(
  auth: AuthCtx,
  fixtureId: string,
  side: Side,
  deps: { video?: ArbiterVideo } = {},
): Promise<ArbiterJoin> {
  const userId = requireWatcher(auth);
  const f = await loadOnlinePlayFixture(fixtureId);
  if (f === null || f.orgId !== auth.orgId) throw new HttpError(404, "fixture not found", "NOT_FOUND");
  await rateLimit(`arbiter-join:${fixtureId}:${userId}`, ARBITER_JOIN_LIMIT);
  // C1 (D7 safeguarding): a player never watches their opponent's camera,
  // and an organiser who plays on this board is its player. Refused before
  // any participant is minted.
  if (await isSeatedOn(userId, fixtureId)) {
    throw new HttpError(403, "You play on this board, so another organiser must watch it", "ARBITER_PLAYS_THIS_BOARD");
  }
  // M2: a board that is over, or whose round was never opened, has no match to watch.
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

  // The player's meeting, as it stands NOW: made for the board's current pairing (a row an earlier pairing left is no
  // meeting for this one), and not ended. Read, never made.
  const [meeting] = await sql<{ meetingId: string; endedAt: Date | null; samePair: boolean }[]>`
    select m.meeting_id as "meetingId", m.ended_at as "endedAt",
           (m.home_entrant_id, m.away_entrant_id) is not distinct from (f.home_entrant_id, f.away_entrant_id) as "samePair"
      from fixture_video_meetings m
      join fixtures f on f.id = m.fixture_id
     where m.fixture_id = ${fixtureId} and m.side = ${side}`;
  if (!meeting || !meeting.samePair) {
    throw new HttpError(409, "this player has not checked in yet", "VIDEO_MEETING_NOT_STARTED");
  }
  if (meeting.endedAt !== null) throw new HttpError(409, "this player's video meeting has ended", "VIDEO_MEETING_ENDED");

  const video = deps.video ?? REAL_ARBITER_VIDEO;
  let token: ParticipantToken;
  try {
    token = await mintArbiter({ fixtureId, side, userId, meetingId: meeting.meetingId }, video);
  } catch (err) {
    if (!(err instanceof RealtimeKitError)) throw err;
    // D21: a deferral (the platform's call budget is spent) is the same 503 — try again — but it is not an error to report.
    if (!(err instanceof RealtimeKitDeferred)) {
      captureError(err, {
        orgId: f.orgId,
        route: "external-play/arbiter",
        extra: { fixtureId, side, status: err.status, code: err.code },
      });
    }
    throw new HttpError(503, "video is unavailable right now", "VIDEO_UNAVAILABLE");
  }

  // The players in THIS meeting: the side's own player's participants (the peers' `userId`). The meeting holds no one else.
  const sides = await loadSides(f);
  const player = side === "home" ? sides.home : sides.away;
  const players =
    player.personId === null
      ? []
      : await sql<{ participantId: string }[]>`
          select participant_id as "participantId"
            from fixture_video_participants
           where fixture_id = ${fixtureId} and side = ${side} and preset = 'player' and person_id = ${player.personId}
           order by created_at, id`;
  return {
    authToken: token.authToken,
    participantId: token.participantId,
    side,
    players: players.map((p) => p.participantId),
  };
}

/** A fresh arbiter participant for this open, on file before its token is
 *  handed out. A record that cannot be written leaves no participant behind:
 *  it is removed at the vendor at once, so nothing watches untracked. */
async function mintArbiter(
  a: { fixtureId: string; side: Side; userId: string; meetingId: string },
  video: ArbiterVideo,
): Promise<ParticipantToken> {
  // `subject` is RealtimeKit's custom_participant_id: internal ids only, never
  // an email or a name (realtimekit.ts addParticipant). T17B fix 2 (D3): the
  // vendor's add-participant is IDEMPOTENT on that id within a meeting
  // (measured: the same id answers the SAME participant), so a bare user id
  // handed a second open the first open's participant — the record refused
  // it, the catch below deleted it at the vendor, and every open tab of that
  // organiser lost its watch. Each OPEN is its own participant: the user id
  // and a nonce.
  const minted = await video.addParticipant({ meetingId: a.meetingId, subject: `${a.userId}:${randomUUID()}`, preset: "arbiter" });
  try {
    await sql`
      insert into fixture_video_participants (fixture_id, side, person_id, preset, participant_id, user_id)
      values (${a.fixtureId}, ${a.side}, null, 'arbiter', ${minted.participantId}, ${a.userId})`;
  } catch (err) {
    // Best effort: a refusal (the call budget, D21) leaves the minted participant at the vendor with no row of ours
    // naming it - nothing retries it. It is receive-only (the arbiter preset) and holds no token we gave out.
    await video.removeParticipant({ meetingId: a.meetingId, participantId: minted.participantId }).catch(() => undefined);
    // The vendor's participant is gone (or going): a record already holding it
    // must not stay a live watch. Arbiter rows only (V454: a player's is never
    // removed).
    await sql`
      update fixture_video_participants set removed_at = now()
       where fixture_id = ${a.fixtureId} and side = ${a.side} and participant_id = ${minted.participantId}
         and preset = 'arbiter' and removed_at is null`;
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
      join fixture_video_meetings m on m.fixture_id = vp.fixture_id and m.side = vp.side
     where vp.fixture_id = ${fixtureId} and vp.participant_id = ${participantId}
       and vp.preset = 'arbiter' and vp.user_id = ${auth.userId} and f.org_id = ${auth.orgId}`;
  if (!row) throw new HttpError(404, "no such arbiter participant", "NOT_FOUND");
  if (row.removedAt !== null) return { removed: false };
  if (row.meetingEndedAt === null) {
    try {
      await (deps.video ?? REAL_ARBITER_VIDEO).removeParticipant({ meetingId: row.meetingId, participantId });
    } catch (err) {
      if (!(err instanceof RealtimeKitError)) throw err;
      // D21: as the join — a deferral is a retry, not an error to report. The watch stays open for the sweep either way.
      if (!(err instanceof RealtimeKitDeferred)) {
        captureError(err, {
          orgId: auth.orgId,
          route: "external-play/arbiter/leave",
          extra: { fixtureId, status: err.status, code: err.code },
        });
      }
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
