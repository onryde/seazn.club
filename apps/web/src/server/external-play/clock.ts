import type { LichessClock } from "./types";

export type BoardgameClockInput = {
  base: number;
  increment?: number;
  delay?: number;
};

export type MapClockResult =
  | { ok: true; clock: LichessClock }
  | { ok: false; reason: "missing_clock" | "delay_unsupported" };

/**
 * Map Seazn boardgame clock metadata to a Lichess challenge clock.
 * Bronstein/delay is not supported for Lichess sync in v1 (spec §6.2).
 */
export function mapBoardgameClockToLichess(
  clock: BoardgameClockInput | undefined,
): MapClockResult {
  if (!clock) return { ok: false, reason: "missing_clock" };
  if (clock.delay !== undefined) return { ok: false, reason: "delay_unsupported" };
  return {
    ok: true,
    clock: {
      limit: clock.base,
      increment: clock.increment ?? 0,
    },
  };
}
