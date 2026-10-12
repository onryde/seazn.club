// The match room's wire shape and the pure derivations both ends share.
//
// Isomorphic on purpose: the room usecase (server) composes a RoomSnapshot
// from these helpers and the room shell (client) reads the same type, so a
// field cannot mean one thing on each side. Nothing here touches the DB, a
// token or Lichess; `@/server/external-play/window` is a pure module.
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
  outcome: "won" | "lost" | "draw";
  /** boardgame.result's method, when one was recorded. */
  method: string | null;
  /** White's score first, the way a chess result is written. */
  score: "1–0" | "0–1" | "½–½";
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
  /** null ⇒ not asked (policy off, no meeting, or the vendor did not answer). */
  opponentCameraLive: boolean | null;
  /** Which seat a token_revoked hold froze, from the VIEWER's side. */
  frozen: "you" | "opponent" | "both" | null;
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

/** The game-over card's facts from the recorded result (winner is an
 *  entrant id, or null for a draw). */
export function resultFor(a: {
  winnerEntrantId: string | null;
  method: string | null;
  myEntrantId: string;
  myColour: Colour;
}): RoomResult {
  if (a.winnerEntrantId === null) return { outcome: "draw", method: a.method, score: "½–½" };
  const iWon = a.winnerEntrantId === a.myEntrantId;
  const whiteWon = iWon === (a.myColour === "white");
  return { outcome: iWon ? "won" : "lost", method: a.method, score: whiteWon ? "1–0" : "0–1" };
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
