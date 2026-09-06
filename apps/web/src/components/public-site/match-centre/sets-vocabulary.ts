// Spectator surface W1, R11 fix round (C8 + its re-review) — ONE authority for
// the word this sport uses for a division of play. The Sets tab's rail label
// and the panel's own caption both name the same thing, and they were derived
// independently: the rail keyed off `sets.unit` (correct) while the caption
// keyed off `sets.kind` (wrong — badminton and table tennis are `kind: "sets"`
// with `unit: "game"`, so they read a "Sets" heading over correctly-labelled
// "Game 1" / "Game 2" columns). A second derivation of the same fact is a
// second chance to get it wrong; both now read this map.
//
// `kind` says how the breakdown is SHAPED (a set array vs a period array) and
// is what the schema branches on. `unit` says what a column is CALLED. They
// are not interchangeable: every `unit` here appears under `kind: "sets"`
// except `period`, and `timeline.ts`'s `buildSets` is the producer of both.
export type SetsUnit = "set" | "game" | "period";

export const SETS_LABEL_KEY: Record<SetsUnit, string> = {
  set: "matchCentre.sets",
  game: "matchCentre.games",
  period: "matchCentre.periods",
};

/**
 * The dictionary key naming this sport's division of play, plural — "Sets",
 * "Games", "Periods". `undefined` covers a document built before `unit`
 * existed: fall back on the SHAPE, which is all such a document carries.
 */
export function setsLabelKey(unit: SetsUnit | undefined, kind: "sets" | "periods"): string {
  if (unit !== undefined) return SETS_LABEL_KEY[unit];
  return kind === "periods" ? "matchCentre.periods" : "matchCentre.sets";
}
