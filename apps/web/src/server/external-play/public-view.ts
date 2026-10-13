// Public-safe external-play bridge snapshot (T9, reshaped T16). No play URL
// (D3 deleted the lichess.org mode, so a public page links to no Lichess
// game), never `last_error` (operator text), never a participant, token or
// draw offer. Isomorphic: the public page's server read, the spectator
// broadcast (lib/realtime) and the watch island all speak this one shape.
import { LICHESS_STATUSES, type LichessStatus } from "./types";

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
};

export type PublicExternalPlay = {
  status: PublicExternalPlayStatus;
  /** Null until a game exists at Lichess. */
  watch: PublicWatch | null;
};

/** What the watch island polls (GET /public/fixtures/{id}/board), and what the
 *  page hands it first: whether the fixture's round is open (D12 — an unopened
 *  round says so, spec §3.2), and the bridge's public snapshot, null until the
 *  board has a bridge row. */
export type PublicWatchDoc = {
  roundOpened: boolean;
  externalPlay: PublicExternalPlay | null;
};

/** Watchable means there is a board to render HERE. `status` alone is not
 *  enough: a `live` row whose `watch` is null would render an empty board,
 *  which reads as a game with no pieces rather than as "not started yet". */
export function isWatchable(ep: PublicExternalPlay): boolean {
  return (ep.status === "live" || ep.status === "finished") && ep.watch !== null;
}

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
