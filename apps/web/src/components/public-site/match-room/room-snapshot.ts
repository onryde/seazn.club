// The match room's wire shape and the pure derivations both ends share.
//
// Isomorphic on purpose: the room usecase (server) composes a RoomSnapshot
// from these helpers and the room shell (client) reads the same type, so a
// field cannot mean one thing on each side. Nothing here touches the DB, a
// token or Lichess; `@/server/external-play/window` is a pure module, and so
// is the engine's boardgame fold.
import { foldMatch } from "@seazn/engine/core";
import { boardgame, BoardgameMethod } from "@seazn/engine/sports/boardgame";
import { roomPhase, windowFor } from "@/server/external-play/window";

export type Colour = "white" | "black";
export type RoomPhaseWire = "not_opened" | "before" | "open" | "closed";
export type CameraPolicyWire = "off" | "optional" | "required";

/** Why a seat was refused, as the client renders it — preflight's
 *  SEAT_REFUSAL_REASONS. `camera_required` / `camera_lost` carry the caller's
 *  own participant token in the POST answer, never in the snapshot. */
export type SeatRefusal =
  | "camera_required"
  | "camera_lost"
  | "window_closed"
  | "not_a_player"
  | "round_not_open"
  | "fixture_not_playable"
  | "video_unavailable"
  | "lichess_link_required"
  | "lichess_reconsent_required";

export type RoomGame = {
  gameId: string;
  /** The ledger: every move Lichess accepted, UCI. */
  moves: string[];
  fen: string;
  lastMove: [string, string] | null;
  turn: Colour;
  whiteMs: number;
  blackMs: number;
  /** When the two clock values were true (the last accepted move), ISO;
   *  null before any move. The client counts down from here. */
  clockAsOf: string | null;
  /** Lichess starts the clocks once BOTH players have moved (ply 2). */
  clockRunning: boolean;
  drawOfferBy: Colour | null;
  /** The game is over at Lichess (the bridge says finished, or reconcile
   *  stamped game_over_at). Never derived from a clock reaching zero. */
  over: boolean;
};

export type RoomResult = {
  /** The engine's outcome, from the viewer's side: a win is won/lost; a
   *  draw; or no result (a double forfeit — chess.md §7). */
  outcome: "won" | "lost" | "draw" | "no_result";
  /** boardgame.result's method, when one was recorded. */
  method: string | null;
  /** White's score first, the way a chess result is written ("1–0",
   *  "½–½", "0–0") — the engine's own points for each side. */
  score: string;
};

export type RoomSnapshot = {
  fixtureId: string;
  /** The server's clock when this was composed — the client derives its
   *  skew from it, never from its own wall clock alone. */
  serverNow: string;
  phase: RoomPhaseWire;
  scheduledAt: string | null;
  roundOpenedAt: string | null;
  opensAt: string | null;
  deadline: string | null;
  links: { fixture: string; standings: string };
  meta: {
    divisionName: string;
    roundNo: number;
    boardNo: number;
    limitSeconds: number;
    incrementSeconds: number;
  };
  orgSlug: string;
  you: { colour: Colour; name: string; checkedIn: boolean };
  opponent: { colour: Colour; name: string; checkedIn: boolean };
  cameraPolicy: CameraPolicyWire;
  /** Where the opponent's presence pill may show, and who the opponent is in
   *  the meeting: their RealtimeKit participant id, or null when they hold no
   *  seat in it (absent by construction). The pill's answer is the viewer's
   *  OWN client's (review I8: opponent-presence.ts) — the server never asks
   *  the vendor for it. null ⇒ no pill (policy off, an override, a board
   *  nobody may play on). */
  opponentPresence: { participantId: string | null } | null;
  /** Which seat a token_revoked hold froze, from the VIEWER's side. null
   *  once a result is written (the result outranks the freeze — review I1). */
  frozen: "you" | "opponent" | "both" | null;
  /** The server would accept an act from YOU on the game on file — T10's
   *  own predicate (play.ts `playableGame` and its frozen seats), not a
   *  second reading. false with no game. A game on file you may not act on
   *  is a held board: never rendered live and movable (review I2). */
  canAct: boolean;
  /** No game on file and the club is not offered online chess (T20). The
   *  client renders a plain state and STOPS polling. */
  onlineChessOff: boolean;
  /** Both in, no game yet: being created, or held back by Lichess's rate
   *  limit until `retryAt`. null otherwise. */
  creation: null | { state: "creating" } | { state: "busy"; retryAt: string | null };
  game: RoomGame | null;
  /** Held for the organiser (needs_organiser) with no result written. */
  held: boolean;
  result: RoomResult | null;
  watchUrl: string | null;
  realtime: { topic: string; token: string; expiresAt: string } | null;
};

/** D12 (spec §3.2): a fixture with no `round_opened_at` is NOT yet playable
 *  and must say so — it is not "before the window", because no window
 *  exists. Once opened, T−10/T+20 are measured from the open, so the shipped
 *  `roomPhase` is reused unchanged with `round_opened_at` in the argument
 *  slot its parameter name still calls `scheduledAt`. The schedule is what
 *  players are SHOWN; it never reaches this function. */
export function roomPhaseWire(a: { now: Date; roundOpenedAt: Date | null }): RoomPhaseWire {
  if (a.roundOpenedAt === null) return "not_opened";
  return roomPhase(a.now, a.roundOpenedAt);
}

/** The open's window, or nulls while the round is unopened. */
export function windowWire(roundOpenedAt: Date | null): { opensAt: string | null; deadline: string | null } {
  if (roundOpenedAt === null) return { opensAt: null, deadline: null };
  const w = windowFor(roundOpenedAt);
  return { opensAt: w.opensAt.toISOString(), deadline: w.deadline.toISOString() };
}

/** A token_revoked hold's frozen seat, as the viewer reads it. */
export function frozenFor(revokedSeat: Colour | "both" | null, mine: Colour): RoomSnapshot["frozen"] {
  if (revokedSeat === null) return null;
  if (revokedSeat === "both") return "both";
  return revokedSeat === mine ? "you" : "opponent";
}

/** The two clock values the board shows and how they run.
 *
 *  Before the first move the bridge has no clock values: both sides show the
 *  division's own limit. Lichess starts the clocks once both have moved, so
 *  `running` is ply ≥ 2 and the game not over. The values are as of
 *  `lastMoveAt` (T10 stores them that way). */
export function gameClocks(a: {
  limitMs: number;
  whiteMs: number | null;
  blackMs: number | null;
  lastMoveAt: Date | null;
  moveCount: number;
  over: boolean;
}): { whiteMs: number; blackMs: number; clockAsOf: string | null; clockRunning: boolean } {
  return {
    whiteMs: a.whiteMs ?? a.limitMs,
    blackMs: a.blackMs ?? a.limitMs,
    clockAsOf: a.lastMoveAt?.toISOString() ?? null,
    clockRunning: a.moveCount >= 2 && !a.over,
  };
}

/** Whose move a ledger of `moveCount` plies leaves. */
export function turnAfter(moveCount: number): Colour {
  return moveCount % 2 === 0 ? "white" : "black";
}

const ENGINE_METHODS: ReadonlySet<string> = new Set(BoardgameMethod.options);
/** The engine's default boardgame scoring IS the FIDE game score (a win 1, a
 *  draw ½, in half-points) — the division's tournament points never change
 *  how a chess result is written. */
const GAME_SCORE_CFG = boardgame.configSchema.parse({});

/** The game-over card's facts from the recorded boardgame.result (winner an
 *  entrant id or null), as the ENGINE folds it (review I7): its outcome kind
 *  — a double forfeit is `no_result`, never a draw — and its points for each
 *  side, White first. A method the engine does not know is carried for the
 *  record and folded as none. A winner who is neither seat is no result this
 *  room can state: null, and the screen says the result is on its way. */
export function resultFor(a: {
  winnerEntrantId: string | null;
  method: string | null;
  myEntrantId: string;
  opponentEntrantId: string;
  myColour: Colour;
}): RoomResult | null {
  if (a.winnerEntrantId !== null && a.winnerEntrantId !== a.myEntrantId && a.winnerEntrantId !== a.opponentEntrantId) {
    return null;
  }
  const white = a.myColour === "white" ? a.myEntrantId : a.opponentEntrantId;
  const black = a.myColour === "white" ? a.opponentEntrantId : a.myEntrantId;
  const method = a.method !== null && ENGINE_METHODS.has(a.method) ? a.method : undefined;
  const at = "1970-01-01T00:00:00.000Z";
  const state = foldMatch(
    boardgame,
    GAME_SCORE_CFG,
    { home: { entrantId: white, slots: [] }, away: { entrantId: black, slots: [] } },
    [
      { id: "start", fixtureId: "room", seq: 0, type: "core.start", payload: {}, recordedAt: at, recordedBy: null },
      {
        id: "result",
        fixtureId: "room",
        seq: 1,
        type: "boardgame.result",
        payload: { winner: a.winnerEntrantId, ...(method === undefined ? {} : { method }) },
        recordedAt: at,
        recordedBy: null,
      },
    ],
  );
  const o = boardgame.outcome(state);
  if (o === null) return null;
  const line = (entrant: string) => boardgame.summary(state).perSide.find((p) => p.entrantId === entrant)?.line ?? "";
  // boardgame.result folds to these three kinds only (the sweep in
  // room-snapshot.test.ts walks every method); anything else is no result
  // this card can word, so it is not worded at all.
  const outcome: RoomResult["outcome"] | null =
    o.kind === "win" ? (o.winner === a.myEntrantId ? "won" : "lost") : o.kind === "draw" || o.kind === "no_result" ? o.kind : null;
  if (outcome === null) return null;
  return { outcome, method: a.method, score: `${line(white)}–${line(black)}` };
}

/** How long the room's realtime subscriber token lives. It used to be the
 *  window's deadline (T+20), which cut a running game's broadcasts off
 *  mid-game (T10 review carry). Now every snapshot read mints one that lives
 *  ROOM_REALTIME_TTL_MS from the read, and the client re-reads well inside
 *  that, so the subscription outlives any game. */
export const ROOM_REALTIME_TTL_MS = 60 * 60_000;

export function realtimeExpiry(now: Date): Date {
  return new Date(now.getTime() + ROOM_REALTIME_TTL_MS);
}
