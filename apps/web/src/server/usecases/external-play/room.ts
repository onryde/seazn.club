import "server-only";
// The match room usecase (chess in-page board design §6, T14). Four entry
// points front every player interaction with the room, each resolving the
// caller to ONE of the fixture's two players first (a session user, or a
// personal link token bound to the round's open) and collapsing every
// failure to one 404:
//   - readRoom       — GET. NEVER writes (spec §12.1).
//   - claimRoomSeat  — POST. Takes the seat through preflight's seatPlayer
//     (the server-verified camera gate), stamps the check-in inside the
//     window, and — when both players are in — asks T9's createGameIfReady.
//     It is the ONE challenge producer here: T8's mintIfReady was a second
//     one with no production caller and is gone (T9 ruling).
//   - actInRoom      — POST act. T10's `act`, then T11's reconcile(game_end)
//     on any answer that ended the game, awaited, so the bridge's
//     finished_at is written by THAT reconcile and not a later sweep (T13
//     job 5's camera window ends there).
//   - reportClockZero — POST clock-zero. A client clock reached zero; if the
//     server's own arithmetic agrees, reconcile(clock_zero) asks Lichess
//     (the measured read + one re-read live in reconcile). We never declare
//     a flag from arithmetic.
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { log } from "@/server/logger";
import { routes } from "@/lib/routes";
import { externalPlayLobbyTopic, mintExternalPlayLobbyToken, publishExternalPlayLobby } from "@/lib/realtime";
import { fixtureCameraPolicy } from "@/server/external-play/camera-policy";
import { roundOpenFor, type RoundOpenRow } from "@/server/external-play/round-open";
import { checkInCounts } from "@/server/external-play/window";
import { hasLiveVideoPublisher, RealtimeKitError, type ParticipantToken } from "@/server/external-play/video/realtimekit";
import { verifyMatchRoomToken } from "@/server/usecases/match-room-token";
import { stampFixtureCheckIn } from "@/server/usecases/me";
import {
  frozenFor,
  gameClocks,
  realtimeExpiry,
  resultFor,
  roomPhaseWire,
  turnAfter,
  windowWire,
  type Colour,
  type RoomGame,
  type RoomSnapshot,
  type SeatRefusal,
} from "@/components/public-site/match-room/room-snapshot";
import {
  effectiveBridge,
  loadOnlinePlayFixture,
  loadSides,
  resetStaleBridge,
  whiteSideOf,
  type OnlinePlayFixture,
  type SidePlayer,
} from "./guard";
import { createGameIfReady, type CreateOutcome } from "./create-game";
import { onlineChessOffered, type OnlineChessAsker } from "./online-chess-flag";
import { act, fenAfter, playableGame, type PlayAction, type PlayResult } from "./play";
import { seatPlayer, type SeatResult } from "./preflight";
import { reconcile } from "./reconcile";
import { throttledRetryAt } from "./sweep";

/** The caller identifies as either a signed-in session (must be one of the
 *  two players) or a personal match-room link token (spec §12.1). */
export type RoomIdentity = { kind: "session"; userId: string } | { kind: "token"; token: string };

export type RoomDeps = {
  now?: Date;
  seat?: typeof seatPlayer;
  create?: (fixtureId: string) => Promise<CreateOutcome>;
  publish?: (fixtureId: string) => Promise<void>;
  offered?: (asker: OnlineChessAsker) => Promise<boolean>;
  presence?: (a: { meetingId: string; participantId: string }) => Promise<boolean>;
  mintRealtime?: typeof mintExternalPlayLobbyToken;
  play?: (a: { fixtureId: string; personId: string; action: PlayAction }) => Promise<PlayResult>;
  reconcile?: (fixtureId: string, trigger: "game_end" | "clock_zero") => Promise<unknown>;
};

/** A seat answer as the CLIENT receives it: the caller's own participant
 *  token (to join the meeting and publish their camera) and nothing else. */
export type SeatWire =
  | { seated: true; participant: ParticipantToken | null }
  | { seated: false; reason: SeatRefusal; participant: ParticipantToken | null };

export type RoomClaim = {
  snapshot: RoomSnapshot;
  /** null ⇒ the seat was not asked: online chess is off for this club and no
   *  game is on file (T20) — the snapshot says so. */
  seat: SeatWire | null;
  /** T9's answer when both players were in and a game was asked for. */
  create: CreateOutcome | null;
};

/** How close to zero the server's own arithmetic must put the side to move
 *  before a clock-zero report is worth a Lichess read. Generous: the client
 *  ticks from the broadcast's receipt, so it runs a little behind the
 *  server; a report earlier than this is refused without a read. */
export const CLOCK_ZERO_TOLERANCE_MS = 2_000;

const ROOM_NOT_FOUND = () => new HttpError(404, "This match room could not be found", "NOT_FOUND");

type Resolved = {
  f: OnlinePlayFixture;
  player: SidePlayer & { personId: string };
  home: SidePlayer;
  away: SidePlayer;
  open: RoundOpenRow | null;
};

/**
 * The fixture, the round's open and which of its two players `identity` is.
 * Session identity matches ONLY a side's solo `userId`. Token identity
 * requires the token's fixture to be THIS fixture and its `roundOpenId` to be
 * this fixture's round's open (T19 review M4: bound to the open, not the
 * schedule — a NULL-time board resolves; a token for another round never
 * does). Every failure — no such fixture, not an online fixture, a bad or
 * expired token, another fixture or round, a person on neither side —
 * collapses to the same 404 so a probe learns nothing.
 */
async function resolveRoom(identity: RoomIdentity, fixtureId: string): Promise<Resolved> {
  const f = await loadOnlinePlayFixture(fixtureId);
  if (!f) throw ROOM_NOT_FOUND();
  const [{ home, away }, open] = await Promise.all([loadSides(f), roundOpenFor(sql, fixtureId)]);
  let player: SidePlayer | undefined;
  if (identity.kind === "session") {
    player = [home, away].find((s) => s.userId !== null && s.userId === identity.userId);
  } else {
    const claims = await verifyMatchRoomToken(identity.token).catch(() => null);
    if (!claims || claims.fixtureId !== f.fixtureId) throw ROOM_NOT_FOUND();
    if (open === null || claims.roundOpenId !== open.id) throw ROOM_NOT_FOUND();
    player = [home, away].find((s) => s.personId !== null && s.personId === claims.personId);
  }
  // An empty side has personId null; it can never be the caller.
  if (!player || player.personId === null) throw ROOM_NOT_FOUND();
  return { f, player: player as SidePlayer & { personId: string }, home, away, open };
}

/** Check-in state for both sides, scoped by fixture_id AND the two resolved
 *  person ids, judged against the open's window. Exported for T13's no-show
 *  sweep, which must judge "who came" by exactly this reading. */
export async function checkIns(
  f: OnlinePlayFixture,
  home: SidePlayer,
  away: SidePlayer,
  anchor: Date | null,
): Promise<{ home: boolean; away: boolean }> {
  // An unopened round has no window, so no check-in can count toward it —
  // and one stamped during a PREVIOUS round's window must not either (D12).
  if (anchor === null) return { home: false, away: false };
  const ids = [home.personId, away.personId].filter((p): p is string => p !== null);
  const rows =
    ids.length === 0
      ? []
      : await sql<{ person_id: string; checked_in_at: Date | null }[]>`
          select person_id, checked_in_at from fixture_availability
           where fixture_id = ${f.fixtureId}
             and person_id in ${sql(ids)}`;
  const at = (p: string | null) => (p === null ? null : (rows.find((r) => r.person_id === p)?.checked_in_at ?? null));
  return {
    home: checkInCounts(at(home.personId), anchor),
    away: checkInCounts(at(away.personId), anchor),
  };
}

/** Display and lifecycle facts the guard's snapshot does not carry. */
type RoomFacts = {
  divisionName: string;
  roundNo: number;
  boardNo: number;
  lastError: string | null;
  createSentAt: Date | null;
  gameOverAt: Date | null;
  videoOverrideAt: Date | null;
};

async function roomFacts(fixtureId: string): Promise<RoomFacts> {
  const [row] = await sql<RoomFacts[]>`
    select d.name as "divisionName", f.round_no as "roundNo", f.seq_in_round as "boardNo",
           ep.last_error as "lastError", ep.create_sent_at as "createSentAt",
           ep.game_over_at as "gameOverAt", ep.video_override_at as "videoOverrideAt"
      from fixtures f
      join divisions d on d.id = f.division_id
      left join fixture_external_play ep on ep.fixture_id = f.id
     where f.id = ${fixtureId}`;
  if (!row) throw ROOM_NOT_FOUND();
  return row;
}

/** The latest boardgame.result on the ledger that nothing voided. */
async function recordedResult(fixtureId: string): Promise<{ winner: string | null; method: string | null } | null> {
  const [row] = await sql<{ payload: { winner?: string | null; method?: string } }[]>`
    select e.payload from score_events e
     where e.fixture_id = ${fixtureId} and e.type = 'boardgame.result'
       and not exists (select 1 from score_events v where v.voids_event_id = e.id)
     order by e.seq desc limit 1`;
  if (!row) return null;
  return { winner: row.payload.winner ?? null, method: row.payload.method ?? null };
}

/** The opponent's camera as the meeting reports it: joined and not left.
 *  null ⇒ not asked (no meeting, no participant yet, an override) or the
 *  vendor did not answer — the pill then shows nothing rather than a guess. */
async function opponentPresence(
  fixtureId: string,
  opponentPersonId: string | null,
  deps: RoomDeps,
): Promise<boolean | null> {
  if (opponentPersonId === null) return null;
  const [row] = await sql<{ meetingId: string; participantId: string }[]>`
    select m.meeting_id as "meetingId", p.participant_id as "participantId"
      from fixture_video_meetings m
      join fixture_video_participants p on p.fixture_id = m.fixture_id
     where m.fixture_id = ${fixtureId} and m.ended_at is null
       and p.person_id = ${opponentPersonId} and p.preset = 'player'
     order by p.created_at, p.id
     limit 1`;
  if (!row) return false;
  try {
    return await (deps.presence ?? hasLiveVideoPublisher)(row);
  } catch (err) {
    if (err instanceof RealtimeKitError) return null;
    throw err;
  }
}

async function compose(r: Resolved, now: Date, deps: RoomDeps): Promise<RoomSnapshot> {
  const { f, player, home, away, open } = r;
  const anchor = open?.roundOpenedAt ?? null;
  const bridge = effectiveBridge(f);
  const facts = await roomFacts(f.fixtureId);
  const phase = roomPhaseWire({ now, roundOpenedAt: anchor });
  const ci = await checkIns(f, home, away, anchor);
  const opponent = player.side === "home" ? away : home;

  // T10 review carry: once a game exists its RECORDED colours are the truth;
  // the pairing is read only before one does.
  const whiteSide = bridge?.white_side ?? (await whiteSideOf(f));
  const mine: Colour = whiteSide === player.side ? "white" : "black";
  const theirs: Colour = mine === "white" ? "black" : "white";

  const gameOnFile = bridge !== null && bridge.challenge_id !== null;
  const over = bridge !== null && (bridge.status === "finished" || facts.gameOverAt !== null);
  let game: RoomGame | null = null;
  if (bridge !== null && bridge.challenge_id !== null) {
    const moves = bridge.moves_uci;
    const last = moves.length > 0 ? moves[moves.length - 1]! : null;
    game = {
      gameId: bridge.challenge_id,
      moves,
      fen: fenAfter(moves).fen,
      lastMove: last === null ? null : [last.slice(0, 2), last.slice(2, 4)],
      turn: turnAfter(bridge.move_count),
      ...gameClocks({
        limitMs: f.clock.limit * 1_000,
        whiteMs: bridge.white_ms,
        blackMs: bridge.black_ms,
        lastMoveAt: bridge.last_move_at,
        moveCount: bridge.move_count,
        over,
      }),
      drawOfferBy: bridge.draw_offer_by,
      over,
    };
  }

  const recorded = f.fixtureStatus === "scheduled" || f.fixtureStatus === "in_play" ? null : await recordedResult(f.fixtureId);
  const result =
    recorded === null
      ? null
      : resultFor({ winnerEntrantId: recorded.winner, method: recorded.method, myEntrantId: player.entrantId, myColour: mine });

  // T11 M7: a token_revoked hold freezes a seat (or both, when none was
  // recorded); the other player's board stays live. A WRITTEN result ends
  // the freeze for the room (T14 review I1, controller ruling): reconcile
  // writes a held game's result without closing the hold (finish() closes
  // only ready/live), and the frozen player must see how the game ended.
  const frozen =
    result === null && bridge?.status === "needs_organiser" && bridge.needs_reason === "token_revoked"
      ? frozenFor(bridge.revoked_seat ?? "both", mine)
      : null;

  // Who may act: play.ts's own predicate, never a second reading (review
  // I2). A seat it freezes, every other hold and a finished board accept
  // nothing; the room renders that board held, never live and movable.
  const playable = gameOnFile ? playableGame(f) : null;
  const canAct = playable !== null && !playable.frozen.includes(mine);
  // A hold the game is not still playing through (T12's mid-game diagnoses
  // are token_revoked / provider_error; anything else, or any hold once the
  // game is over, waits on the organiser).
  const midGameHold = bridge?.needs_reason === "token_revoked" || bridge?.needs_reason === "provider_error";
  const held = bridge?.status === "needs_organiser" && result === null && (over || !midGameHold || !gameOnFile);

  // T20: online play STARTS only for a club offered it; a board with a game
  // (or a create already sent) is never gated.
  const startPending = !gameOnFile && facts.createSentAt === null;
  const onlineChessOff = startPending && !(await (deps.offered ?? onlineChessOffered)({ orgId: f.orgId, userId: player.userId }));

  const bothIn = ci.home && ci.away;
  let creation: RoomSnapshot["creation"] = null;
  if (!gameOnFile && phase === "open" && bothIn && !onlineChessOff && !held) {
    const throttled = facts.lastError?.startsWith("create:rate_limited") === true;
    creation = throttled
      ? { state: "busy", retryAt: throttledRetryAt(facts.lastError ?? "")?.toISOString() ?? null }
      : { state: "creating" };
  }

  // T11 re-review: a held board that is still moving keeps its link.
  const watchUrl = gameOnFile ? `https://lichess.org/${bridge!.challenge_id}` : null;

  const cameraPolicy = await fixtureCameraPolicy(f.fixtureId);
  const opponentCameraLive =
    cameraPolicy === "off" || facts.videoOverrideAt !== null || over
      ? null
      : await opponentPresence(f.fixtureId, opponent.personId, deps);

  let realtime: RoomSnapshot["realtime"] = null;
  try {
    const expiresAt = realtimeExpiry(now);
    const token = await (deps.mintRealtime ?? mintExternalPlayLobbyToken)(f.fixtureId, player.personId, expiresAt);
    realtime = { topic: externalPlayLobbyTopic(f.fixtureId), token, expiresAt: expiresAt.toISOString() };
  } catch {
    // No realtime key in this environment: the client polls.
    realtime = null;
  }

  const youIn = player.side === "home" ? ci.home : ci.away;
  const theyIn = player.side === "home" ? ci.away : ci.home;
  return {
    fixtureId: f.fixtureId,
    serverNow: now.toISOString(),
    phase,
    scheduledAt: f.scheduledAt?.toISOString() ?? null,
    roundOpenedAt: anchor?.toISOString() ?? null,
    ...windowWire(anchor),
    links: {
      fixture: routes.sharedFixture(f.orgSlug, f.competitionSlug, f.divisionSlug, f.fixtureId),
      standings: routes.shared(f.orgSlug, f.competitionSlug, f.divisionSlug),
    },
    meta: {
      divisionName: facts.divisionName,
      roundNo: facts.roundNo,
      boardNo: facts.boardNo,
      limitSeconds: f.clock.limit,
      incrementSeconds: f.clock.increment,
    },
    orgSlug: f.orgSlug,
    you: { colour: mine, name: player.displayName, checkedIn: youIn },
    opponent: { colour: theirs, name: opponent.displayName, checkedIn: theyIn },
    cameraPolicy,
    opponentCameraLive,
    frozen,
    canAct,
    onlineChessOff,
    creation,
    game,
    held,
    result,
    watchUrl,
    realtime,
  };
}

/** GET the room. NEVER writes — no stale-row reset, no stamp, no create: a
 *  stale bridge is simply hidden (`effectiveBridge`) until a write path
 *  resets it. */
export async function readRoom(identity: RoomIdentity, fixtureId: string, deps: RoomDeps = {}): Promise<RoomSnapshot> {
  const r = await resolveRoom(identity, fixtureId);
  return compose(r, deps.now ?? new Date(), deps);
}

function seatWire(seat: SeatResult): SeatWire {
  if (seat.seated) return { seated: true, participant: seat.participant };
  if (seat.reason === "camera_required" || seat.reason === "camera_lost") {
    return { seated: false, reason: seat.reason, participant: seat.participant };
  }
  return { seated: false, reason: seat.reason, participant: null };
}

/**
 * POST — take the seat. Order: identity → lazy stale-bridge reset (a write
 * path) → the T20 start gate (only while no game is on file) → seatPlayer
 * (preflight: the window, the play grant, the server-verified camera) → on a
 * seat inside the open window with no game yet, stamp the check-in and ping
 * the lobby → with BOTH in, ask T9 for the game. A re-entering player (a
 * reload mid-game) is seated by seatPlayer's own re-entry rule and gets their
 * camera token back; their check-in is never re-stamped, because a stamp
 * outside the window would read as never having come.
 */
export async function claimRoomSeat(identity: RoomIdentity, fixtureId: string, deps: RoomDeps = {}): Promise<RoomClaim> {
  const now = deps.now ?? new Date();
  let r = await resolveRoom(identity, fixtureId);
  await resetStaleBridge(r.f);
  r = await resolveRoom(identity, fixtureId);
  const bridge = effectiveBridge(r.f);
  const gameOnFile = bridge !== null && bridge.challenge_id !== null;
  const facts = await roomFacts(fixtureId);

  if (!gameOnFile && facts.createSentAt === null) {
    const offered = await (deps.offered ?? onlineChessOffered)({ orgId: r.f.orgId, userId: r.player.userId });
    if (!offered) return { snapshot: await compose(r, now, deps), seat: null, create: null };
  }

  const seat = await (deps.seat ?? seatPlayer)({ fixtureId, personId: r.player.personId }, { now });
  let create: CreateOutcome | null = null;
  const anchor = r.open?.roundOpenedAt ?? null;
  if (seat.seated && !gameOnFile && roomPhaseWire({ now, roundOpenedAt: anchor }) === "open") {
    await stampFixtureCheckIn(r.player.personId, fixtureId, r.f.orgId);
    await (deps.publish ?? publishExternalPlayLobby)(fixtureId);
    const ci = await checkIns(r.f, r.home, r.away, anchor);
    if (ci.home && ci.away) create = await (deps.create ?? ((id: string) => createGameIfReady(id, { now })))(fixtureId);
  }
  const fresh = await resolveRoom(identity, fixtureId);
  return { snapshot: await compose(fresh, now, deps), seat: seatWire(seat), create };
}

/** The answers after which the game is over at Lichess, so T11 must read it
 *  NOW: resign, abort, a draw "yes" (lila's /draw/yes — it accepts a
 *  standing offer; on a mere offer the read finds the game running and
 *  changes nothing), and a move T10 reports as ending it. */
function endedTheGame(action: PlayAction, result: PlayResult): boolean {
  if (!result.ok) return false;
  if (result.ended === true) return true;
  return action.kind === "resign" || action.kind === "abort" || (action.kind === "draw" && action.accept);
}

/** POST act — T10's usecase, then reconcile(game_end) on a game-ending
 *  answer, awaited before the player's answer goes back. */
export async function actInRoom(
  identity: RoomIdentity,
  fixtureId: string,
  action: PlayAction,
  deps: RoomDeps = {},
): Promise<PlayResult> {
  const r = await resolveRoom(identity, fixtureId);
  const result = await (deps.play ?? act)({ fixtureId, personId: r.player.personId, action });
  if (endedTheGame(action, result)) {
    try {
      await (deps.reconcile ?? ((id, trigger) => reconcile(id, trigger)))(fixtureId, "game_end");
    } catch (err) {
      // The move or resignation stands at Lichess either way; the sweep
      // reconciles a game this read missed. Never fail the player's answer.
      log.error({ fixtureId, err }, "match room: reconcile(game_end) after a game-ending act failed");
    }
  }
  return result;
}

/** POST clock-zero. `reconciled: false` ⇒ nothing was asked of Lichess:
 *  there is no running game, or the server's own arithmetic says the side
 *  to move still has time. */
export async function reportClockZero(
  identity: RoomIdentity,
  fixtureId: string,
  deps: RoomDeps = {},
): Promise<{ reconciled: boolean }> {
  const now = deps.now ?? new Date();
  const r = await resolveRoom(identity, fixtureId);
  const b = effectiveBridge(r.f);
  if (b === null || b.challenge_id === null || b.status === "finished" || b.last_move_at === null) {
    return { reconciled: false };
  }
  if (b.move_count < 2) return { reconciled: false };
  const toMove = turnAfter(b.move_count);
  const base = toMove === "white" ? b.white_ms : b.black_ms;
  if (base === null) return { reconciled: false };
  const remaining = base - (now.getTime() - b.last_move_at.getTime());
  if (remaining > CLOCK_ZERO_TOLERANCE_MS) return { reconciled: false };
  await (deps.reconcile ?? ((id, trigger) => reconcile(id, trigger)))(fixtureId, "clock_zero");
  return { reconciled: true };
}
