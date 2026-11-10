// W4 app B, Task 9 (X-TP-1, X-TP-2): "Third place: Shared / Play-off match" - the ONE reading of the setting and the ONE
// size predicate, for the server (the PATCH, Generate) and the builder alike. Pure and client-safe (no runtime import).

/** Shared: the two semi-final losers share 3rd. Play-off match: they play a third-place match, ranked 3rd and 4th apart. */
export type ThirdPlaceMode = "shared" | "playoff";

/** X-TP-1: a third-place match needs two real semi-finals, so a field of 4. Below it the play-off is not offered. */
export const THIRD_PLACE_MIN = 4;

/** X-TP-2's one default: only a stored `thirdPlace: true` is Play-off; absent, false or anything else reads Shared. */
export function thirdPlaceModeOf(cfg: { thirdPlace?: unknown } | null | undefined): ThirdPlaceMode {
  return cfg?.thirdPlace === true ? "playoff" : "shared";
}

/** The stored form of a mode (`config.thirdPlace`). */
export const thirdPlaceFlagOf = (mode: ThirdPlaceMode): boolean => mode === "playoff";

/** X-TP-1: whether a knockout of `n` entrants can play a third-place match. */
export function thirdPlaceOffered(n: number): boolean {
  return Number.isFinite(n) && n >= THIRD_PLACE_MIN;
}
