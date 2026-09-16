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
