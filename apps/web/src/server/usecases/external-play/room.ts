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
//   - reportCameraFault — POST camera-fault (T14 re-review 3, I-1). The
//     player's browser left the meeting because it could not refuse a remote
//     stream (D7) and is re-joining: OUR fault, stamped on the server's clock
//     for the caller's OWN seat, so T13 job 5 never flags the gap and the
//     opponent sees no pill (not "camera off") while it is open.
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { CAMERA_FAULT_PING_LIMIT, rateLimit } from "@/lib/rate-limit";
import { log } from "@/server/logger";
import { routes } from "@/lib/routes";
import { externalPlayLobbyTopic, mintExternalPlayLobbyToken, publishExternalPlayLobby } from "@/lib/realtime";
import { fixtureCameraPolicy } from "@/server/external-play/camera-policy";
import { roundOpenFor, type RoundOpenRow } from "@/server/external-play/round-open";
import { checkInCounts } from "@/server/external-play/window";
import { isSeatHold } from "@/server/external-play/types";
import type { ParticipantToken } from "@/server/external-play/video/realtimekit";
import { closeGuardFault, GUARD_FAULT_MAX_STAMPS, hasOpenGuardFault, openGuardFault } from "@/server/external-play/video/guard-faults";
import { verifyMatchRoomToken } from "@/server/usecases/match-room-token";
import { stampFixtureCheckIn } from "@/server/usecases/me";
import {
  frozenFor,
  gameClocks,
  realtimeExpiry,
  ABANDONED_RESULT,
  decisiveResultFor,
  withSettle,
  type DecisiveEvent,
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
import { act, actAcceptance, playableGame, type PlayAction, type PlayResult } from "./play";
import { fenAfter } from "@/server/external-play/fen";
import { isPlayableFixtureStatus, seatPlayer, storedPlayerParticipant, type SeatResult } from "./preflight";
import { lichessGrantDowngraded } from "../external-accounts";
import { RECONCILED_WHILE_HELD, reconcile } from "./reconcile";
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
  mintRealtime?: typeof mintExternalPlayLobbyToken;
  play?: (a: { fixtureId: string; personId: string; action: PlayAction }) => Promise<PlayResult>;
  reconcile?: (fixtureId: string, trigger: "game_end" | "clock_zero") => Promise<unknown>;
  /** P10: Lichess's word on a user's grant (external-accounts.ts `lichessGrantDowngraded`). */
  grantDowngraded?: (userId: string | null) => Promise<boolean>;
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

/** One Lichess read per (game, ply) per this long, however many reports
 *  arrive — both players' clocks reach zero together (review m5). Shorter
 *  than the client's own report spacing (use-room CLOCK_ZERO_SPACING_MS), so
 *  a client's spaced retry — the read on which Lichess settles a flag — is
 *  never swallowed. Per process. */
export const CLOCK_ZERO_COOLDOWN_MS = 2_500;
const clockZeroReadAt = new Map<string, number>();

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

/** The latest event on the ledger that nothing voided and that decided the game: a boardgame.result, or — W2b spec
 *  §5.2 records every chess forfeit this way — a core.forfeit (a no-show's walkover, the organiser's default win or
 *  No result). */
async function recordedResult(fixtureId: string): Promise<(DecisiveEvent & { seq: number }) | null> {
  const [row] = await sql<(DecisiveEvent & { seq: number })[]>`
    select e.type, e.payload, e.seq from score_events e
     where e.fixture_id = ${fixtureId} and e.type in ('boardgame.result', 'core.forfeit')
       and not exists (select 1 from score_events v where v.voids_event_id = e.id)
     order by e.seq desc limit 1`;
  return row ?? null;
}

/** Final review M-1: the winner of the organiser's settle of a level knockout game (`core.settle`, resolve.ts — W2a's
 *  tie-break), the latest recorded after the deciding event; null when there is none. No void filter: a voided settle
 *  puts the tie-break back, so the fixture is open again and the room reads no result at all (tested). */
async function settledWinner(fixtureId: string, afterSeq: number): Promise<string | null> {
  const [row] = await sql<{ winner: string | null }[]>`
    select e.payload->>'winner' as winner from score_events e
     where e.fixture_id = ${fixtureId} and e.type = 'core.settle' and e.seq > ${afterSeq}
     order by e.seq desc limit 1`;
  return row?.winner ?? null;
}

/** Who the opponent is in the fixture's meeting (review I8): their player
 *  participant id — the one preflight keeps per person, the one their client
 *  joins with — or null when they hold no seat in a meeting that is still
 *  open (absent by construction). A DB read only: whether they are in the
 *  meeting and on camera is the viewer's own client's answer
 *  (match-room/opponent-presence.ts), so a room read never calls the
 *  vendor. */
async function opponentParticipant(fixtureId: string, opponentPersonId: string): Promise<string | null> {
  const [row] = await sql<{ participantId: string }[]>`
    select p.participant_id as "participantId"
      from fixture_video_meetings m
      join fixture_video_participants p on p.fixture_id = m.fixture_id
     where m.fixture_id = ${fixtureId} and m.ended_at is null
       and p.person_id = ${opponentPersonId} and p.preset = 'player'
     order by p.created_at, p.id
     limit 1`;
  return row?.participantId ?? null;
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

  // I-3: an abandoned board decided nobody — No result, whatever event the ledger last decided with.
  const recorded =
    f.fixtureStatus === "scheduled" || f.fixtureStatus === "in_play" || f.fixtureStatus === "abandoned" ? null : await recordedResult(f.fixtureId);
  const seats = { myEntrantId: player.entrantId, opponentEntrantId: opponent.entrantId, myColour: mine };
  const result =
    f.fixtureStatus === "abandoned"
      ? ABANDONED_RESULT
      : recorded === null
        ? null
        : withSettle(decisiveResultFor(recorded, seats), await settledWinner(f.fixtureId, recorded.seq), seats);

  // T11 M7: a seat hold (token_revoked; account_changed since the final
  // re-review, P11 (1)) freezes a seat (or both, when none was recorded);
  // the other player's board stays live. A WRITTEN result ends
  // the freeze for the room (T14 review I1, controller ruling): reconcile
  // writes a held game's result without closing the hold (finish() closes
  // only ready/live), and the frozen player must see how the game ended.
  const frozen =
    result === null && bridge?.status === "needs_organiser" && isSeatHold(bridge.needs_reason)
      ? frozenFor(bridge.revoked_seat ?? "both", mine)
      : null;

  // Who may act: play.ts's own predicates, never a second reading (review
  // I2; re-review 5 I-2). No playable game (every other hold, a finished or
  // withdrawn board) accepts nothing; on a playable one, the seat's
  // acceptance — a frozen seat, or a linked account that is not the game's —
  // is the SAME function act() asks. A board play refuses is never rendered
  // live and movable.
  const playable = gameOnFile ? playableGame(f) : null;
  const seat = playable === null ? null : actAcceptance(playable, player);
  const canAct = seat !== null && seat.refused === null;
  // The seat's account is not the game's: re-linking THAT account is the
  // remedy, so the room shows A with the account's own line, NAMING the
  // account T9 recorded (re-review 6, N-2) — Lichess links whichever account
  // the browser is signed in to, so the player must know which to sign in as.
  const otherAccount = seat?.refused === "account" ? seat.recorded : null;
  // A hold the game is not still playing through (T12's mid-game diagnoses
  // are reconcile's RECONCILED_WHILE_HELD — token_revoked, provider_error
  // and, final re-review P11 (1), account_changed; anything else, or any
  // hold once the game is over, waits on the organiser).
  const midGameHold = bridge !== null && (RECONCILED_WHILE_HELD as readonly (string | null)[]).includes(bridge.needs_reason);
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
  // The pill shows only on a live board the viewer may play on (review I8):
  // never before the game, on a held or finished board, or for a frozen seat.
  // An opponent with no person on file cannot be named in the meeting: no
  // pill, rather than a "camera off" nobody can verify.
  // While OUR safeguard holds the opponent's camera out of the meeting (a
  // guard fault, I-1) their absence is not theirs: no pill, never "off".
  const opponentPresence: RoomSnapshot["opponentPresence"] =
    cameraPolicy === "off" ||
    facts.videoOverrideAt !== null ||
    over ||
    !canAct ||
    opponent.personId === null ||
    (await hasOpenGuardFault(sql, { fixtureId: f.fixtureId, personId: opponent.personId }))
      ? null
      : { participantId: await opponentParticipant(f.fixtureId, opponent.personId) };
  // R3-1: who the server holds the viewer as in the meeting — what the room re-claims on when it is not the one its
  // camera joined (a re-pair's retire took it). A DB read: a room read never calls the vendor.
  const ownParticipantId = await storedPlayerParticipant(sql, { fixtureId: f.fixtureId, personId: player.personId });

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
    // Stamped as the snapshot is finished, not when the request began (review
    // m6): the client orders reads and derives its clock skew from this, and
    // a slow read (a vendor call, a busy DB) must not arrive already old.
    serverNow: (deps.now ?? new Date()).toISOString(),
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
    opponentPresence,
    ownParticipantId,
    frozen,
    canAct,
    otherAccount,
    onlineChessOff,
    creation,
    game,
    held,
    result,
    watchUrl,
    realtime,
  };
}

/** Final review P10: whether the VIEWER's Lichess grant, which our row says plays, has been narrowed or revoked at
 *  lichess.org since — asked of Lichess once per page load by the room page, which shows the re-link screen at once
 *  (rather than after an act spends the token). Never on a board with nothing left to play (decided, withdrawn, or
 *  its bridge closed): there is no grant to need, and Lichess's per-IP limit is not spent on it. The same 404 as the
 *  room for anyone not on the board. */
export async function roomGrantDowngraded(identity: RoomIdentity, fixtureId: string, deps: RoomDeps = {}): Promise<boolean> {
  const r = await resolveRoom(identity, fixtureId);
  if (!isPlayableFixtureStatus(r.f.fixtureStatus) || effectiveBridge(r.f)?.status === "finished") return false;
  return (deps.grantDowngraded ?? lichessGrantDowngraded)(r.player.userId);
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
  // Seated again (a reload's way back after a guard fault): our gap is over,
  // even if the page that opened it never said so (I-1).
  if (seat.seated && (await closeGuardFault(sql, { fixtureId, personId: r.player.personId, at: now }))) {
    await (deps.publish ?? publishExternalPlayLobby)(fixtureId);
  }
  let create: CreateOutcome | null = null;
  const anchor = r.open?.roundOpenedAt ?? null;
  if (seat.seated && !gameOnFile && roomPhaseWire({ now, roundOpenedAt: anchor }) === "open") {
    await stampFixtureCheckIn(r.player.personId, fixtureId, r.f.orgId);
    await (deps.publish ?? publishExternalPlayLobby)(fixtureId);
    const ci = await checkIns(r.f, r.home, r.away, anchor);
    if (ci.home && ci.away) create = await (deps.create ?? ((id: string) => createGameIfReady(id, { now })))(fixtureId);
  }
  const fresh = await resolveRoom(identity, fixtureId);
  const snapshot = await compose(fresh, now, deps);
  // T9 checks the flag itself at the send (T20): its refusal is the latest
  // word on it, whatever the room's own read raced to (review m3).
  const refusedOff = create !== null && !create.created && create.reason === "online_chess_disabled";
  return { snapshot: refusedOff ? { ...snapshot, onlineChessOff: true } : snapshot, seat: seatWire(seat), create };
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
  const key = `${fixtureId}:${b.challenge_id}:${b.move_count}`;
  const last = clockZeroReadAt.get(key);
  if (last !== undefined && now.getTime() - last < CLOCK_ZERO_COOLDOWN_MS) return { reconciled: false };
  clockZeroReadAt.set(key, now.getTime());
  if (clockZeroReadAt.size > 1_024) {
    for (const [k, at] of clockZeroReadAt) if (now.getTime() - at > 60_000) clockZeroReadAt.delete(k);
  }
  await (deps.reconcile ?? ((id, trigger) => reconcile(id, trigger)))(fixtureId, "clock_zero");
  return { reconciled: true };
}

export type CameraFaultReport = { state: "start" | "end"; participantId: string };

/**
 * POST camera-fault (I-1). The caller's browser left the meeting because it
 * could not refuse a remote stream (D7), and is re-joining — OUR fault, not
 * the player's camera. `start` opens the interval, `end` closes it, both on
 * the SERVER's clock; a repeated start (or an end with none open) changes
 * nothing and pings nobody. Only the caller's OWN seat: `participantId` must
 * be their player participant in this fixture's meeting, still open —
 * someone else's seat, a player never seated in the meeting and an ended
 * meeting are the room's one 404, like every identity failure. A change pings
 * the room, so the opponent's pill is withdrawn (or restored) at once.
 *
 * Fix round 6, M-2: past GUARD_FAULT_MAX_STAMPS on file a start is refused
 * (429 CAMERA_FAULT_CAP_REACHED, nothing written) — logged once, at the stamp
 * that reaches the cap; an end is always taken. The ping is rate-limited per
 * seat (CAMERA_FAULT_PING_LIMIT): past it the stamp is written, the ping
 * skipped.
 */
export async function reportCameraFault(
  identity: RoomIdentity,
  fixtureId: string,
  body: CameraFaultReport,
  deps: RoomDeps = {},
): Promise<{ open: boolean }> {
  const now = deps.now ?? new Date();
  const r = await resolveRoom(identity, fixtureId);
  const [own] = await sql<{ participantId: string }[]>`
    select p.participant_id as "participantId"
      from fixture_video_participants p
      join fixture_video_meetings m on m.fixture_id = p.fixture_id
     where p.fixture_id = ${fixtureId} and p.person_id = ${r.player.personId} and p.preset = 'player'
       and p.participant_id = ${body.participantId} and m.ended_at is null`;
  if (!own) throw ROOM_NOT_FOUND();
  const personId = r.player.personId;
  const seat = { fixtureId, personId, at: now };
  let changed: boolean;
  if (body.state === "start") {
    const o = await openGuardFault(sql, seat);
    if (o.outcome === "capped") throw CAMERA_FAULT_CAP_REACHED();
    if (o.outcome === "opened" && o.stamps === GUARD_FAULT_MAX_STAMPS) {
      log.warn({ fixtureId, personId, stamps: o.stamps }, "camera-fault: a seat reached the stamp cap; its further starts are refused");
    }
    changed = o.outcome === "opened";
  } else {
    changed = await closeGuardFault(sql, seat);
  }
  if (changed && (await cameraFaultPingAllowed(fixtureId, personId))) await (deps.publish ?? publishExternalPlayLobby)(fixtureId);
  return { open: body.state === "start" };
}

const CAMERA_FAULT_CAP_REACHED = () =>
  new HttpError(429, "Too many camera reconnects on this seat for this match.", "CAMERA_FAULT_CAP_REACHED");

/** The ping's budget (M-2): spent only by a change; a 429 skips the ping. */
async function cameraFaultPingAllowed(fixtureId: string, personId: string): Promise<boolean> {
  try {
    await rateLimit(`room-camera-fault-ping:${fixtureId}:${personId}`, CAMERA_FAULT_PING_LIMIT);
    return true;
  } catch (err) {
    if (err instanceof HttpError && err.status === 429) return false;
    throw err;
  }
}
