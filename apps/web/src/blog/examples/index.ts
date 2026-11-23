// The registry: every example a post can place. The goldens (__golden__/<id>.json) are what a page reads; this
// file is what the regenerate and claims tests walk, and is never imported by a page (it pulls in the engine).
import { chessPoints } from "./chess-points";
import { cricketPoints } from "./cricket-points";
import { matchesWonFirst } from "./matches-won-first";
import { shootoutPoints } from "./shootout-points";
import { standingsPoints } from "./standings-points";
import { tableTennisLoss } from "./table-tennis-loss";
// ---- batch 5 (Task 11) ----
import { ladderChallenge } from "./ladder-challenge";
import { knockoutWithdrawal } from "./knockout-withdrawal";
import { forfeitScores } from "./forfeit-scores";
import { doubleWalkover } from "./double-walkover";
// ---- end batch 5 ----
import type { BlogExample } from "./types";
// --- blog batch 4 (knockouts) ---
import { thirdPlaceMatch } from "./third-place-match";
import { knockoutMatchEndsLevel } from "./knockout-match-ends-level";
import { pagePlayoffAndStepladder } from "./page-playoff-and-stepladder";
import { doubleEliminationExplained } from "./double-elimination-explained";
import { whatIsAPlate } from "./what-is-a-plate";
const BATCH_4: readonly BlogExample[] = [thirdPlaceMatch, knockoutMatchEndsLevel, pagePlayoffAndStepladder, doubleEliminationExplained, whatIsAPlate];
// --- end blog batch 4 ---

export const BLOG_EXAMPLES: readonly BlogExample[] = [
  standingsPoints, shootoutPoints, cricketPoints, chessPoints, tableTennisLoss, matchesWonFirst, ...BATCH_4,
  // ---- batch 5 (Task 11) ----
  ladderChallenge,
  knockoutWithdrawal,
  forfeitScores,
  doubleWalkover,
  // ---- end batch 5 ----
];

export function blogExample(id: string): BlogExample | null {
  return BLOG_EXAMPLES.find((e) => e.id === id) ?? null;
}
