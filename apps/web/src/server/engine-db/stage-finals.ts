import "server-only";
// W4 T21 (AN-1, X-CH-8): "this bracket has nothing left to play and only waits for Complete stage", asked of plain
// fixture rows by READS — the desk's red `final_decided` row (competition-desk.ts) and the Complete-competition
// warning's list (competitions.ts `openStagesOf`). Prod held an eight-entrant knockout whose seven matches were decided
// while its stage stayed open (auto-advance off), so the bracket never ranked and nothing said so.
//
// "Settled" is the engine's `SETTLED_FIXTURE_STATUSES` over `completionEngineStatus`, the completion readers' one
// mapping (a recorded abandon owed its settle is in play, never the void it is stored as). The rule is the one
// auto-advance waits on (scoring.ts `maybeAutoAdvance`: every fixture of the stage finished), so the desk never asks for
// a completion auto-advance would not itself have made: an unplayed bronze holds it back, as it holds auto-advance.
// With every row settled the deciding game is settled too, which is all `isBracketStageComplete` asks of a bracket — so
// that engine call is not repeated here (under this gate it could only ever answer yes).
import { SETTLED_FIXTURE_STATUSES } from "@seazn/engine/competition";
import { isUnseatedSwissByeShell } from "@/lib/swiss-shell";
import type { OpenStageState } from "@/lib/open-stages";
import { BRACKET_KINDS, parseExtKey } from "./competition";
import { completionEngineStatus, rowAwaitsSettle } from "./recorded-abandon";

/** The columns both questions read, as the readers select them. */
export interface StageFinalsRow {
  status: string;
  outcome: unknown;
  has_active_abandon: boolean;
  expunged: boolean;
  no_result: boolean;
}

/** A stage kind whose rounds are bracket positions (`BRACKET_KINDS`, the completion's own list): it has a final. */
export function isBracketStageKind(kind: string): boolean {
  return (BRACKET_KINDS as readonly string[]).includes(kind);
}

/** How many of the stage's fixtures are still to play or owed a settle (not SETTLED on the engine's reading). */
export function unsettledCount(stageKind: string, rows: readonly StageFinalsRow[]): number {
  return rows.filter((f) => !SETTLED_FIXTURE_STATUSES.has(completionEngineStatus(stageKind, f))).length;
}

/** A BRACKET stage with matches, every one of them settled: its final is decided and the one action left is Complete
 *  stage. Every other stage kind answers false (a table stage has no final; the warning words it by its matches). The
 *  empty case is stated: a bracket with no fixtures has decided nothing. */
export function bracketAwaitsCompletion(stageKind: string, rows: readonly StageFinalsRow[]): boolean {
  if (!isBracketStageKind(stageKind)) return false;
  if (rows.length === 0) return false;
  return unsettledCount(stageKind, rows) === 0;
}

/** The row an open stage's warning line reads: the finals columns, what tells a bracket's final (`ext_key`,
 *  `winner_to_fixture`), and what tells an unseated Swiss bye shell. */
export type OpenStageFixtureRow = StageFinalsRow & {
  ext_key: string | null;
  winner_to_fixture: string | null;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
};

/** A bracket's deciding game, by the rule `completeStageIfReady` applies (competition.ts): not a third-place playoff,
 *  and feeding no onward fixture. */
function isFinalRow(r: OpenStageFixtureRow): boolean {
  return !parseExtKey(r.ext_key).thirdPlace && r.winner_to_fixture === null;
}

/** What an OPEN stage waits for, as the Complete-competition warning words it (lib/open-stages.ts), and how many of its
 *  matches are left. Empty case first: a stage with no matches says so. A bracket is worded by its final: every match
 *  settled is the desk's `final_decided` (`bracketAwaitsCompletion`); the final settled with others still owed (AN-2's
 *  bronze) is its matches left; the final held for a decision is `final_held`; otherwise the final is still to play.
 *  Any other stage by its matches left. An unseated Swiss bye shell is never a match (`isUnseatedSwissByeShell`: a bye
 *  takes no court and no time; the desk counts it as nothing owed). */
export function openStageState(
  stageKind: string,
  rows: readonly OpenStageFixtureRow[],
): { state: OpenStageState; matchesLeft: number } {
  const matches = rows.filter((r) => !isUnseatedSwissByeShell(r));
  const matchesLeft = unsettledCount(stageKind, matches);
  if (matches.length === 0) return { state: "no_matches", matchesLeft };
  if (isBracketStageKind(stageKind)) {
    if (bracketAwaitsCompletion(stageKind, matches)) return { state: "final_decided", matchesLeft };
    const finals = matches.filter(isFinalRow);
    const settled = (r: OpenStageFixtureRow) => SETTLED_FIXTURE_STATUSES.has(completionEngineStatus(stageKind, r));
    if (finals.length > 0 && finals.every(settled)) return { state: "matches_left", matchesLeft };
    if (finals.some((r) => r.status === "needs_decision" || rowAwaitsSettle(stageKind, r))) return { state: "final_held", matchesLeft };
    return { state: "final_pending", matchesLeft };
  }
  return { state: matchesLeft > 0 ? "matches_left" : "all_played", matchesLeft };
}
