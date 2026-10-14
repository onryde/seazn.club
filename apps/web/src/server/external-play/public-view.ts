// Public-safe external-play bridge snapshot (T9, reshaped T16). No play URL
// (D3 deleted the lichess.org mode, so a public page links to no Lichess
// game), never `last_error` (operator text), never a participant, token or
// draw offer. Isomorphic: the public page's server read, the spectator
// broadcast (lib/realtime) and the watch island all speak this one shape.
import { LICHESS_STATUSES, type LichessStatus, type NeedsReason } from "./types";

export type PublicExternalPlayStatus = "pending" | "ready" | "live" | "finished" | "needs_organiser";

/** The view-only board a spectator watches (design §3.4 step 3). `ply` is the
 *  number of half-moves the position stands after: the order of two boards. */
export type PublicWatch = {
  fen: string;
  lastMove: string | null;
  turn: "white" | "black";
  ply: number;
  /** Null until a clock has been read; never 0 for "unknown" (0 reads as a flag). */
  whiteMs: number | null;
  blackMs: number | null;
  /** When the clock values were true (the last move), or null. */
  asOf: string | null;
  /** Lichess starts the clocks once both sides have moved, and stops them when the game ends. */
  clockRunning: boolean;
  over: boolean;
  /** Which entrant plays White, once the game recorded it. */
  whiteSide: "home" | "away" | null;
  /** The plies the position stands after, in standard notation, oldest first (T16 fix round 1, I4: the move
   *  list). A push moves the board ahead of it; the next poll brings the list level. */
  moves: string[];
};

/** Why a held board waits, in the public's words (T16 fix round 1, I4). A knockout draw waits for the organiser to
 *  say who goes through; any other hold waits for a result to be confirmed. Never the hold's own reason or its
 *  operator text. */
export type PublicHold = "tiebreak" | "confirm";

/** Every hold reason's public reading — a Record, so a reason added to the vocabulary cannot go unread. `null`: the
 *  game goes on while the hold stands (a revoked token is one seat's problem; the board is still played), so the
 *  spectators keep the live board. */
export const PUBLIC_HOLD: Record<NeedsReason, PublicHold | null> = {
  no_show_white: "confirm",
  no_show_black: "confirm",
  no_show_both: "confirm",
  not_started: "confirm",
  aborted: "confirm",
  mismatch: "confirm",
  provider_error: "confirm",
  token_revoked: null,
  double_walkover_blocked: "confirm",
  create_outcome_unknown: "confirm",
  tiebreak_owed: "tiebreak",
  fair_play: "confirm",
  // Final re-review P11 (1): one seat's link, like a revoked token — the game plays on at Lichess and reconcile
  // keeps reading it, so the spectators keep the live board.
  account_changed: null,
  // T17B fix 2, D11: a clock ran out and Lichess has not ended the game — the result waits on the organiser.
  clock_flag_unsettled: "confirm",
};

/** The fixture's recorded result, for the finished board's header ("X won · Checkmate · move 30 · 1–0"). Read
 *  from the fixture itself (its engine outcome and its public summary), so the header can never disagree with the
 *  result printed above the panel. */
export type PublicGameResult = {
  kind: "win" | "draw" | "no_result";
  winner: "home" | "away" | null;
  /** The engine's method (boardgame's vocabulary), when one was recorded. */
  method: string | null;
  /** White's score first ("1–0", "½–½"); home first while no game recorded the colours. */
  score: string;
  /** When the fixture got its result. */
  recordedAt: string | null;
};

/** The division Fixtures list's watch link for an online board (T16 fix round 1, I4; canvas WatchStatesDesktop A):
 *  a game being played, a game over (its score White first, "" when none is recorded), or a round not opened. */
/** "starting" (T17 owner change, 2026-10-13): the round open, both players paired, no move yet, nothing held. */
/** `noResult` (I-3): the board was abandoned — VOID, nobody's result — so the link says No result, not a score. */
export type PublicWatchLink =
  | { kind: "live" }
  | { kind: "final"; score: string; noResult: boolean }
  | { kind: "not_opened" }
  | { kind: "starting" };

export type PublicExternalPlay = {
  status: PublicExternalPlayStatus;
  /** Null until a game exists at Lichess. */
  watch: PublicWatch | null;
  /** The FIXTURE is no longer playable — decided on the pad, settled, walked over, voided or cancelled (T16 fix
   *  round 1, I1). Its game is over for the spectators whatever the bridge row still reads, and nothing is polled
   *  for it any more. */
  decided: boolean;
  /** Why the board is held, while its fixture is still open; null otherwise. */
  hold: PublicHold | null;
  /** The fixture's result once it has one. */
  result: PublicGameResult | null;
};

/** What the watch island polls (GET /public/fixtures/{id}/board), and what the
 *  page hands it first: whether the fixture's round is open (D12 — an unopened
 *  round says so, spec §3.2), and the bridge's public snapshot, null until the
 *  board has a bridge row. */
export type PublicWatchDoc = {
  roundOpened: boolean;
  /** When the round was opened (the Match details line), or null while it is not. */
  roundOpenedAt: string | null;
  externalPlay: PublicExternalPlay | null;
};

const LIVE_STATUSES: ReadonlySet<LichessStatus> = new Set<LichessStatus>(["created", "started"]);

/** A broadcast's Lichess status, as the spectator's "is it over". Every status
 *  but the two live ones ends the game (types.ts lists all fourteen). */
export function overFromStatus(status: LichessStatus): boolean {
  if (!(LICHESS_STATUSES as readonly string[]).includes(status)) throw new Error(`overFromStatus: unknown status ${String(status)}`);
  return !LIVE_STATUSES.has(status);
}

/** The ply a FEN stands after, from its own fields (side to move and the
 *  fullmove number): `(fullmove − 1) × 2`, plus one when Black is to move. */
export function plyOfFen(fen: string): number {
  const [, side, , , , full] = fen.split(" ");
  const fullmove = Number(full);
  if ((side !== "w" && side !== "b") || !Number.isInteger(fullmove) || fullmove < 1) {
    throw new Error(`plyOfFen: not a FEN: ${fen}`);
  }
  return (fullmove - 1) * 2 + (side === "b" ? 1 : 0);
}

/** The spectators' copy of a room broadcast (lib/realtime's `board_state` on
 *  `fixture:{id}`): the board alone. The draw offer stays with the players. */
export type PublicBoardPush = {
  fen: string;
  lastMove: string | null;
  turn: "white" | "black";
  ply: number;
  whiteMs: number;
  blackMs: number;
  over: boolean;
};

export function spectatorBoard(b: {
  fen: string;
  lastMove: string | null;
  turn: "white" | "black";
  whiteMs: number;
  blackMs: number;
  status: LichessStatus;
}): PublicBoardPush {
  return {
    fen: b.fen,
    lastMove: b.lastMove,
    turn: b.turn,
    ply: plyOfFen(b.fen),
    whiteMs: b.whiteMs,
    blackMs: b.blackMs,
    over: overFromStatus(b.status),
  };
}

const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const isClock = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;

/** A `board_state` payload as it arrives over the wire, checked: the board
 *  fields and nothing else, or null for anything that is not one. The
 *  channel is ours, but a payload is data — an unreadable one is dropped,
 *  never drawn. */
export function readBoardPush(x: unknown): PublicBoardPush | null {
  if (x === null || typeof x !== "object") return null;
  const p = x as Record<string, unknown>;
  if (typeof p.fen !== "string" || p.fen.length === 0) return null;
  if (!(p.lastMove === null || (typeof p.lastMove === "string" && UCI.test(p.lastMove)))) return null;
  if (p.turn !== "white" && p.turn !== "black") return null;
  if (typeof p.ply !== "number" || !Number.isInteger(p.ply) || p.ply < 0) return null;
  if (!isClock(p.whiteMs) || !isClock(p.blackMs)) return null;
  if (typeof p.over !== "boolean") return null;
  return { fen: p.fen, lastMove: p.lastMove, turn: p.turn, ply: p.ply, whiteMs: p.whiteMs, blackMs: p.blackMs, over: p.over };
}
