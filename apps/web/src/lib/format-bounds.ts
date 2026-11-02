// The bounds of a division's format fields — ONE declaration, read by the division builder's Format tab, the Settings
// Format group and the stage-config validator (Match Day D1, design 2026-10-31 Phase D).
//
// The two forms used to carry their own literals, and they disagreed: Settings took 1-4 legs where the builder offered
// two, Settings started rounds at 3 where the builder and the validator start at 1, and the builder offered a fixed list
// of Top N values where Settings took any number from 2 to 32. An organiser could therefore build a division the other
// form could not express, and the second form would show or save a different value than the first.
//
// Where each number comes from:
// - legs 1-2: the owner's ruling (2026-10-31), "Once" or "Home & away", in both forms.
// - pools 2-8, Top N 2-32 and rounds up to 15: the forms' own maxima. The engine declares none of them and the validator
//   declares no maximum for any of them.
// - rounds from 1: the validator's minimum (Settings' 3 was the odd one out).
//
// DELIBERATELY a module with no imports, like capacity-bounds.ts: `server/api-v1/schemas.ts` reads it through a relative
// `.ts` import, so it must load under plain node (the OpenAPI generator, tools/matrix), and the client forms read it too.

export const FORMAT_BOUNDS = {
  /** Times each pair meets in a league or group stage (`config.legs`). */
  legs: { min: 1, max: 2 },
  /** Pools in a group stage (`config.pools.count`). */
  pools: { min: 2, max: 8 },
  /** Rounds in a Swiss stage (`config.rounds`). */
  swissRounds: { min: 1, max: 15 },
  /** How many advance to the second stage (the Top N knob). */
  qualify: { min: 2, max: 32 },
} as const;

export type FormatBoundKey = keyof typeof FORMAT_BOUNDS;

/** True when `value` is a whole number inside the field's bounds. A stored value outside them is shown as it is, with
 *  an explanation — never clamped silently (Match Day D1). */
export function withinFormatBounds(field: FormatBoundKey, value: number): boolean {
  const { min, max } = FORMAT_BOUNDS[field];
  return Number.isInteger(value) && value >= min && value <= max;
}
