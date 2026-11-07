// W4 T21 (AN-1, X-CH-8; owner pick R24 4A, ruling 273): the open stages a Complete-competition warning lists. Pure
// types and one rule, shared by the server read (`openStagesOf`, usecases/competitions.ts) and the client warning
// (components/v2/open-stages-warning.tsx), so neither restates the other.

/** What an open stage is waiting for. Exhaustive: the warning has one line per state.
 *  - `final_decided`: a bracket whose deciding game is settled and nothing else is owed — only Complete stage is left;
 *  - `final_pending`: a bracket whose final is still to be played;
 *  - `final_held`: a bracket whose final was played but is held for a decision (level, or a recorded abandon owed its
 *    settle) — never "not played yet" (W4 T21 review M3);
 *  - `matches_left`: a table stage with matches still to play or owed a settle — and a bracket whose final IS decided
 *    while other matches (a bronze) are still owed (AN-2);
 *  - `all_played`: any other stage with every match settled — only Complete stage is left;
 *  - `no_matches`: a stage with no fixtures at all. */
export const OPEN_STAGE_STATES = ["final_decided", "final_pending", "final_held", "matches_left", "all_played", "no_matches"] as const;
export type OpenStageState = (typeof OPEN_STAGE_STATES)[number];

export interface OpenStageRow {
  stageId: string;
  divisionName: string;
  /** The stage's own position in its division (1-based). */
  seq: number;
  stageName: string;
  state: OpenStageState;
  /** Matches still to play or owed a settle. Printed only for `matches_left`. */
  matchesLeft: number;
}

/** The states whose ONE remaining action is Complete stage — the rows the warning offers it on. */
export function onlyCompletionLeft(state: OpenStageState): boolean {
  return state === "final_decided" || state === "all_played";
}
