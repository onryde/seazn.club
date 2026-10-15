// Per-sport fold epoch (engine-split D26). Bump a sport's number in the SAME change that makes an existing event sequence
// fold differently for that sport (any state, outcome, summary or delta). scripts/fold-epoch-guard.ts enforces it against
// HEAD^1. Native clients send their epoch; the server refuses one lower than this for the fixture's sport (D31).
export const FOLD_EPOCH = {
  football: 1, cricket: 1, boardgame: 1, carrom: 1, generic: 1, volleyball: 1,
  badminton: 1, tabletennis: 1, tennis: 1, icehockey: 1, hockey: 1,
} as const satisfies Readonly<Record<string, number>>;
export type FoldEpochSport = keyof typeof FOLD_EPOCH;
export function foldEpochOf(sport: string): number {
  // Own keys only: a plain lookup answers "constructor" or "toString" with a function from Object.prototype.
  if (!Object.hasOwn(FOLD_EPOCH, sport)) throw new Error(`no FOLD_EPOCH for sport "${sport}" — every registered sport must have one`);
  return (FOLD_EPOCH as Readonly<Record<string, number>>)[sport] as number;
}
