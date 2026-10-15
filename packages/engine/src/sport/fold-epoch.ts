// Per-sport fold epoch (engine-split D26). Bump a sport's number in the SAME change that makes an existing event sequence
// fold differently for that sport (any state, outcome, summary or delta): packages/engine/scripts/fold-epoch-guard.ts (CI:
// `fold-epoch:check --against HEAD^1`) fails a change to a golden corpus that does not. Planned in batch 1f (D31): native clients
// send their epoch and the server refuses one lower than this for the fixture's sport.
//
// THIS FILE IMPORTS NOTHING, and a test holds it so. The guard reads the BASELINE's copy of it out of git (`ls-tree` + `cat-file --batch`)
// into a temp file and imports that, where no relative import resolves; a copy with an import would not load there.
export const FOLD_EPOCH = {
  football: 1, cricket: 1, boardgame: 1, carrom: 1, generic: 1, volleyball: 1,
  badminton: 1, tabletennis: 1, tennis: 1, icehockey: 1, hockey: 1,
} as const satisfies Readonly<Record<string, number>>;
export type FoldEpochSport = keyof typeof FOLD_EPOCH;
export function foldEpochOf(sport: string): number {
  // Own keys only: a plain lookup answers "constructor" or "toString" with a function from Object.prototype.
  // A plain Error, not an EngineError: importing one would break the import-free rule above. A caller that needs a typed code (1f's server)
  // resolves the sport through the registry first, which throws EngineError("MODULE_NOT_FOUND") for an unknown sport, and only then asks here.
  if (!Object.hasOwn(FOLD_EPOCH, sport)) throw new Error(`no FOLD_EPOCH for sport "${sport}" — every registered sport must have one`);
  return (FOLD_EPOCH as Readonly<Record<string, number>>)[sport] as number;
}
