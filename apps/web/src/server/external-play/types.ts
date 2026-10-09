// External-play bridge types (chess Lichess design 2026-09-15).
// Provider union leaves room for chess.com later; v1 only implements lichess.

export type ExternalPlayProvider = "lichess";

export type ExternalPlayStatus =
  | "pending"
  | "ready"
  | "live"
  | "finished"
  | "needs_organiser";

/** Spec §9 / row `needs_reason` — why a fixture landed in `needs_organiser`. */
export type NeedsReason =
  | "no_show_white"
  | "no_show_black"
  | "no_show_both"
  | "not_started"
  | "aborted"
  | "mismatch"
  | "provider_error";

/** Lichess challenge clock: `limit` is initial time in seconds. */
export type LichessClock = { limit: number; increment: number };

/** Board API failure classes. Every one is a MEASURED response — see
 *  lichess/board-api.ts for the bodies and the dates. */
export type BoardErrorCode =
  | "not_your_turn_or_over"   // 400 "Not your turn, or game already over"  (M6)
  | "unplayable_time_control" // 400 "This game cannot be played with the Board API." (M12)
  | "rate_limited"            // 429 (M3 — creation; M4: moves are not limited)
  | "unauthorized"            // 401/403 — token revoked or wrong scope
  | "unavailable";            // 5xx, network, timeout, or a body we have not measured

export type BoardCall = { ok: true } | { ok: false; code: BoardErrorCode; raw: string };

/** Lichess terminal and non-terminal statuses. `aborted` is NOT a synonym for
 *  "no game": M9 measured an early resign landing there with no winner. */
export type LichessStatus =
  | "created" | "started" | "mate" | "resign" | "outoftime"
  | "draw" | "stalemate" | "aborted" | "timeout" | "noStart" | "unknownFinish";

/** One export read. `whiteMs`/`blackMs` are null when the export carried no
 *  `clocks` array — null, never 0, because 0 would read as a flag (M11). */
export type GameSnapshot = {
  gameId: string;
  status: LichessStatus;
  winner: "white" | "black" | null;
  movesSan: string[];
  whiteMs: number | null;
  blackMs: number | null;
  increment: number;
};

/** Minimal game snapshot we need to map a result (from API or recorded fixture). */
export type LichessGameSnapshot = {
  id: string;
  status: string;
  winner?: "white" | "black";
  players: {
    white: { userId: string | null };
    black: { userId: string | null };
  };
};

export type CreateOpenChallengeInput = {
  whiteUsername: string;
  blackUsername: string;
  clock: LichessClock;
  expiresAt: Date;
};

export type OpenChallenge = {
  challengeId: string;
  urlWhite: string;
  urlBlack: string;
};

export interface ExternalPlayAdapter {
  createOpenChallenge(input: CreateOpenChallengeInput): Promise<OpenChallenge>;
  /** null = no such game yet (404 — open challenge not accepted, or game not created). */
  fetchGame(gameId: string): Promise<LichessGameSnapshot | null>;
}

export class LichessHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "LichessHttpError";
  }
}
