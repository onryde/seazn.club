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
// ---- blog batch 2 (tie-breaks, posts #7 to #12) ----
import { levelOnPoints } from "./level-on-points";
import { threeWayTie } from "./three-way-tie";
import { netRunRate } from "./net-run-rate";
import { setRatioOrDifference } from "./set-ratio-or-difference";
import { buchholzSonnebornBerger } from "./buchholz-sonneborn-berger";
import { buchholzBye } from "./buchholz-bye";
import { drawingLots } from "./drawing-lots";
// ---- end blog batch 2 ----
// ---- batch 3 (Swiss and seeding) ----
import { knockoutSeeds } from "./knockout-seeds";
import { swissBye, swissByeRounds } from "./swiss-bye";
import { swissLateAndWithdraw } from "./swiss-late-and-withdraw";
import { swissPairing } from "./swiss-pairing";
// ---- end batch 3 ----
import type { BlogExample } from "./types";
// ---- batch 6 (Task 12: round robins, groups, qualification, leaving and joining) ----
import { roundRobinSchedule } from "./round-robin-schedule";
// ---- end batch 6 ----
// --- blog batch 4 (knockouts) ---
import { thirdPlaceMatch } from "./third-place-match";
import { knockoutMatchEndsLevel } from "./knockout-match-ends-level";
import { pagePlayoffAndStepladder } from "./page-playoff-and-stepladder";
import { doubleEliminationExplained } from "./double-elimination-explained";
import { whatIsAPlate } from "./what-is-a-plate";
const BATCH_4: readonly BlogExample[] = [thirdPlaceMatch, knockoutMatchEndsLevel, pagePlayoffAndStepladder, doubleEliminationExplained, whatIsAPlate];
// --- end blog batch 4 ---

/** Blog batch 2's examples (tie-breaks), in post order. */
const BATCH_2: readonly BlogExample[] = [levelOnPoints, threeWayTie, netRunRate, setRatioOrDifference, buchholzSonnebornBerger, buchholzBye, drawingLots];

export const BLOG_EXAMPLES: readonly BlogExample[] = [
  standingsPoints, shootoutPoints, cricketPoints, chessPoints, tableTennisLoss, matchesWonFirst, ...BATCH_2, ...BATCH_4,
  // ---- batch 5 (Task 11) ----
  ladderChallenge,
  knockoutWithdrawal,
  forfeitScores,
  doubleWalkover,
  // ---- end batch 5 ----
  // ---- batch 3 (Swiss and seeding) ----
  swissPairing,
  swissBye,
  swissByeRounds,
  swissLateAndWithdraw,
  knockoutSeeds,
  // ---- end batch 3 ----
  // ---- batch 6 (Task 12) ----
  roundRobinSchedule,
  // ---- end batch 6 ----
];

export function blogExample(id: string): BlogExample | null {
  return BLOG_EXAMPLES.find((e) => e.id === id) ?? null;
}
