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
  // Boardgame, carrom and generic took their second major on main: the kernel refuses core.lineup.* for a sport that declares no lineupPolicy (owner ruling
  // 2026-10-15), so a phone that still OFFERS a lineup change there must update; their golden withdrawal stream was re-recorded without the four lineup events.
  // It is the write path that refuses. Replay is lenient, so a ledger that already holds such an event still reads and folds on an old phone; "folds" is not
  // what moved the major. ROLLOUT COST, stated plainly: the server's 426 epoch gate refuses ALL scoring writes of these three sports from a client on the
  // old epoch, not just the lineup ones. No such client exists in this repo today; one outside it must update before it can score these sports again.
  // W2c raised boardgame once more (its third): the Armageddon tie-break names who had Black (BG-KO-2), so the knockoutTiebreak floor
  // stream was re-recorded in place.
  // W2c raised football, hockey, carrom and generic one MAJOR for opt-in cfg keys an older phone strips or refuses
  // (football shootoutAttempts; hockey abandonPolicy "q4_stands"; carrom and generic abandonPolicy "share"), so carrom and generic are at their third.
  // W2d (T3, PS-1) raised football, hockey and icehockey one MAJOR: `points.shootoutWin/shootoutLoss` are gone (a phone that still sends them has
  // them stripped), football and hockey take `soBonus` instead, and a shoot-out win's standingsDelta pays the plain win (the 2/1 booking is the
  // table rule's). Their recorded configs were converted (soBonus = shootoutWin - draw), so the guard reads the streams as re-recorded.
  // W2d T18 (HK-TB-2, B3; owner PS-7d) raised hockey once more (its fourth): the write path refuses a hockey.goal without its
  // type (GOAL_KIND_REQUIRED), so a phone that still sends an untyped goal must update, and the corpus's untyped goals were
  // re-recorded as field goals (kind "fg"). As with the lineup refusal, it is the write path that refuses: replay is lenient,
  // and a recorded untyped goal still folds as a field goal.
  // W2e T3 (BD-SE-1, X-SE-1) raised badminton to 2: the write path refuses scoring after a black card until its ending (ENDING_SANCTION_PENDING), and golden stream default#11 recorded rallies after one, so it was re-recorded in place (the ending replaces the refused rally, and the walk ends there).
  // W2e T3 (controller ruling on the set-kernel generator) raised table tennis to 2: arbitraryEvent draws only the sport's own sanction levels, so the three floor walks that drew a referee's expulsion draw a penalty there (summary and state moved; outcome and deltas did not), re-recorded in place.
  // W2e T4 (TN-SE-1, X-SE-1; TN-SS-1) raised tennis to 2 (its minor back to 0): the write path refuses scoring after a default until its ending (ENDING_SANCTION_PENDING) and a set summary no set can reach (SET_SCORE_UNREACHABLE); coverage walk default#13 recorded a point after a default, so the ending replaced it in place (the walk ends there), and the floor no longer derives its disqualification story default#700007, which recorded play after a default too.
  // W2e T5 (RB2A-12, TN-SS-2) rides that same second major: an opt-in key an older phone strips. `set.tiebreakWinBy` (a set tie-break's own margin:
  // short sets and Fast4 win it 5–4 on a deciding point) lives in tennis's non-strict `set` object, so an older phone strips it (spec E29) and folds
  // that tie-break to the match's two, while every recorded stream folded the same; the branch stream short-sets#90011 (golden-branches.ts, T13)
  // now shows the guard a margin of one. T13: a final-set tie-break plays to the match's margin, never the set's own (RBS:349); no recorded stream moved.
  // W2e T6 (CK-CH-1, RB2A-22) raised cricket to 2: the write path refuses a coarse chase total past target - 1 + 7 (CHASE_OVERSHOOT), and golden streams 24 and 29 recorded one, so both were re-recorded in place.
  // W2e T9 (HK-SO-1/2, IH-SO-1/2, RB2B-10) raised hockey to 5 and icehockey to 3: the write path refuses a shoot-out attempt out of the federation's order (FIH series / IIHF tie-break) and `summary.shootoutNext` names that side, `shootout.suddenDeath` is gone from the cfg (a phone that still sends it has it stripped), and hockey streams 17, 21 and icehockey 3, 4, 12 were re-recorded in place.
  // W2e T10 (BG-RS-1, RB2B-20) raised boardgame to 4: the write path refuses a `boardgame.result` whose method contradicts its winner (RESULT_METHOD_CONTRADICTS_WINNER), so a phone that still sends one must update. No recorded stream holds one, so no golden stream was re-recorded; replay is lenient and a stored contradiction still folds to its recorded result.
  // W2e T11 (CA-AD-1, SC-O9) raised carrom to 4: the write path refuses a `carrom.game.adjust` that moves a score by more than the match's gameTo (ADJUST_OUT_OF_RANGE), so a phone that still sends one must update. No recorded stream holds one (13 recorded adjusts, none above 1 point), so no golden stream was re-recorded; replay is lenient and a stored out-of-range adjust still folds to its recorded result.
  // W2e T12 (D6) raised generic to 4: the inert `progressScore` cfg key is deleted (nothing ever read it). No event folds differently, but every state embeds its config, so the 106 recorded states in 64 streams lost the key and the recorded configs were converted (the key removed as text, then REBASELINE_GOLDEN); a phone that still sends the key has it stripped on parse, and a ledger stored with it still folds to the same outcome, summary and standings delta. Removing the stored copies is Task 13b's pre-deploy data migration (W2e), not part of this change.
  // W2e T32 fix round 1 (M12b; PO decision I-1) raised football to 4: a `core.lineup.*` event is judged against football's own pitch (`squadsForLineup`), so a `football.sub` counts. The write path now accepts retiring the substitute who came on by `football.sub` (an older phone refuses it, and on replay drops it and keeps him on the pitch) and refuses retiring the starter he replaced or a player sent off (an older phone accepted both). No recorded stream reaches it (the one football stream with lineup events has no `football.sub` and only a yellow card before them), so the guard sees no corpus change and no golden stream was re-recorded: a manual major (GOLDEN-POLICY "What the guard cannot see").
  football: 4, cricket: 2, boardgame: 4, carrom: 4, generic: 4, volleyball: 1,
  badminton: 2, tabletennis: 2, tennis: 2, icehockey: 3, hockey: 5,
} as const satisfies Readonly<Record<string, number>>);
export type FoldEpochSport = keyof typeof FOLD_EPOCH;
// The same sports as FOLD_EPOCH: `satisfies` over its keys makes a sport missing here, or one only here, a type error.
export const FOLD_MINOR = Object.freeze({
  // W2d T11 (TN-TB-2, RB2A-11) raised tennis one MINOR: the nested kernel's table `gamesOf` credits a won match tie-break as one game
  // to its winner, so a stream ending in one moves its standings deltas (games_won/games_lost) and no state, outcome or summary.
  // W2e T4 reset it to 0 with tennis's second MAJOR.
  // W2e T8 (CK-RR-1, ICC 16.10.7) raised cricket one MINOR: a DLS or revised-overs result credits Team 1 the par or the final target - 1 off Team 2's overs, so golden stream 25 (default#844) moves its NRR deltas and no state, outcome or summary.
  football: 0, cricket: 1, boardgame: 0, carrom: 0, generic: 0, volleyball: 0,
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
