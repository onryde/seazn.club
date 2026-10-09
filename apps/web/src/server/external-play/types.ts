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
  // createChallengeToUser: a DEFINITE failure — Lichess answered 4xx and
  // nothing was created. Every other call: any failure not classified above,
  // 5xx, network and timeout included (the split below is creation-only).
  | "unavailable"
  // createChallengeToUser only: timeout, network error, 5xx, or a 2xx with no
  // usable id — a challenge MAY exist at Lichess. Never release a creation
  // claim on this code: look the challenge up before any re-create (Task 3-5
  // review T3-I2). Synthetic: no 5xx or timeout was measured.
  | "outcome_unknown";

export type BoardCall = { ok: true } | { ok: false; code: BoardErrorCode; raw: string };

/** EVERY status Lichess can return, in the order the OpenAPI declares them
 *  (lichess-org/api doc/specs/schemas/GameStatusName.yaml at 59ebacb; the same
 *  14 cases as scalachess core/src/main/scala/Status.scala at 2ab0a40). A
 *  runtime list, not just a type, because the export is VALIDATED against it.
 *  `aborted` is NOT a synonym for "no game": M9 measured an early resign
 *  landing there with no winner. */
export const LICHESS_STATUSES = [
  "created", "started", "aborted", "mate", "resign", "stalemate", "timeout",
  "draw", "outoftime", "cheat", "noStart", "unknownFinish",
  "insufficientMaterialClaim", "variantEnd",
] as const;
export type LichessStatus = (typeof LICHESS_STATUSES)[number];

const LICHESS_STATUS_SET: ReadonlySet<string> = new Set(LICHESS_STATUSES);

export function isLichessStatus(value: string): value is LichessStatus {
  return LICHESS_STATUS_SET.has(value);
}

/** One export read. `whiteMs`/`blackMs` are null when the export carried no
 *  `clocks` array — null, never 0, because 0 would read as a flag (M11).
 *
 *  `status` is either a status Lichess declares or the explicit marker
 *  `"unrecognised"`, which carries Lichess's own word in `rawStatus` — so a
 *  status added after 2026-10-09 reaches an organiser instead of being read as
 *  one of ours (T12 routes it; a switch over `status` must handle it). */
export type GameSnapshot = {
  gameId: string;
  winner: "white" | "black" | null;
  movesSan: string[];
  whiteMs: number | null;
  blackMs: number | null;
  increment: number;
} & (
  | { status: LichessStatus }
  | { status: "unrecognised"; rawStatus: string }
);

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
