// External-play bridge types (chess Lichess design 2026-09-15).
// Provider union leaves room for chess.com later; v1 only implements lichess.

export type ExternalPlayProvider = "lichess";

export type ExternalPlayStatus =
  | "pending"
  | "ready"
  | "live"
  | "finished"
  | "needs_organiser";

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
