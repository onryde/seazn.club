// Per-sport fold version (engine-split D26, D34): a PAIR (major, minor) per sport, bumped in the SAME change that makes an existing event
// sequence fold differently for that sport. packages/engine/scripts/fold-epoch-guard.ts (CI: `fold-epoch:check --against HEAD^1`) fails a
// change to a golden corpus that does not, and says which half is owed.
//
//   MAJOR (FOLD_EPOCH, foldEpochOf): what a PHONE computes moved - a state, an outcome or a summary - or a golden stream was removed or
//     re-recorded. A phone must update. Native clients send their major and the server refuses one below its own for the fixture's sport
//     (batch 1f, D31). This is the number the server's gate compares.
//   MINOR (FOLD_MINOR, foldMinorOf): only what the SERVER computes moved (a stream's standings deltas, with its states, outcome and summary
//     byte for byte the same). Informational: no app update is required, and nothing refuses a phone for it.
//     This is a CONTRACT, not something the code enforces: a phone must not compute or render `standingsDelta`, `supportsDraws` or any credit
//     on a metric the summary does not show (`standingsDelta` is in the `./sport` closure, so no type stops it). If a phone ever does, a
//     minor no longer means "no app update"; D34 (docs/superpowers/specs/2026-10-13-engine-split-design.md) must be revisited first.
//
// The pair only goes up, lexicographically: a major that rose may reset the minor to 0. Anything ambiguous is a major.
//
// THIS FILE IMPORTS NOTHING, and a test holds it so. The guard reads the BASELINE's copy of it out of git (`ls-tree` + `cat-file --batch`)
// into a temp file and imports that, where no relative import resolves; a copy with an import would not load there. (A baseline from before
// FOLD_MINOR existed has no such table: the guard reads that as a minor of 0 for every sport.)
// Frozen: the server holds these objects for the life of its process, and nothing may edit, add to or empty them.
export const FOLD_EPOCH = Object.freeze({
  football: 1, cricket: 1, boardgame: 1, carrom: 1, generic: 1, volleyball: 1,
  badminton: 1, tabletennis: 1, tennis: 1, icehockey: 1, hockey: 1,
} as const satisfies Readonly<Record<string, number>>);
export type FoldEpochSport = keyof typeof FOLD_EPOCH;
// The same sports as FOLD_EPOCH: `satisfies` over its keys makes a sport missing here, or one only here, a type error.
export const FOLD_MINOR = Object.freeze({
  football: 0, cricket: 0, boardgame: 0, carrom: 0, generic: 0, volleyball: 0,
  badminton: 0, tabletennis: 0, tennis: 0, icehockey: 0, hockey: 0,
} as const satisfies Readonly<Record<FoldEpochSport, number>>);

function entryOf(table: Readonly<Record<string, number>>, name: "FOLD_EPOCH" | "FOLD_MINOR", sport: string): number {
  // Own keys only: a plain lookup answers "constructor" or "toString" with a function from Object.prototype.
  // A plain Error, not an EngineError: importing one would break the import-free rule above. A caller that needs a typed code (1f's server)
  // resolves the sport through the registry first, which throws EngineError("MODULE_NOT_FOUND") for an unknown sport, and only then asks here.
  if (!Object.hasOwn(table, sport)) throw new Error(`no ${name} for sport "${sport}" — every registered sport must have one`);
  return table[sport] as number;
}
/** The MAJOR: a phone below this for the fixture's sport must update. */
export function foldEpochOf(sport: string): number {
  return entryOf(FOLD_EPOCH, "FOLD_EPOCH", sport);
}
/** The MINOR: informational, no app update required. */
export function foldMinorOf(sport: string): number {
  return entryOf(FOLD_MINOR, "FOLD_MINOR", sport);
}
