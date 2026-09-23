// The fixture statuses the schedule's history and its bulk edits treat as
// PLAYED: the rows they never delete, move or clear. It is the set `deleteStage`
// (usecases/stages.ts) already refuses on.
//
// ONE definition, in a leaf module (no imports), because two writers act on it
// and must agree. `history.ts` feeds it to the engine's results-guard, which
// refuses any undo/redo whose op touches such a row. `shiftDivisionSchedule`
// (schedule-plus.ts) skips such rows in a rain-delay shift. When the shift
// read `'decided'` alone, it moved an in-play kick-off, and the guard then
// refused to undo or redo that very shift.
//
// `forfeited` / `abandoned` are not here on purpose: a generation writes them
// itself (a bye, a departed qualifier), with nothing played to lose.
export const PLAYED_FIXTURE_STATUSES: readonly string[] = ["in_play", "decided", "finalized"];

export function isPlayedFixtureStatus(status: string): boolean {
  return PLAYED_FIXTURE_STATUSES.includes(status);
}
