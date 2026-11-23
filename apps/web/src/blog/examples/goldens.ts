// What a post renders from: each example's committed golden, imported statically so the build needs no engine run
// and no file read at request time (the standalone build ships no src/). A new example adds its line here;
// blog-examples.test.ts fails on a golden file with no line, and on a line with no registered example.
import chessPoints from "./__golden__/chess-points.json";
import cricketPoints from "./__golden__/cricket-points.json";
import matchesWonFirst from "./__golden__/matches-won-first.json";
import shootoutPoints from "./__golden__/shootout-points.json";
import standingsPoints from "./__golden__/standings-points.json";
import tableTennisLoss from "./__golden__/table-tennis-loss.json";
// ---- batch 5 (Task 11) ----
import ladderChallenge from "./__golden__/ladder-challenge.json";
import knockoutWithdrawal from "./__golden__/knockout-withdrawal.json";
import forfeitScores from "./__golden__/forfeit-scores.json";
import doubleWalkover from "./__golden__/double-walkover.json";
// ---- end batch 5 ----
// ---- blog batch 2 (tie-breaks, posts #7 to #12) ----
import levelOnPoints from "./__golden__/level-on-points.json";
import threeWayTie from "./__golden__/three-way-tie.json";
import netRunRate from "./__golden__/net-run-rate.json";
import setRatioOrDifference from "./__golden__/set-ratio-or-difference.json";
import buchholzSonnebornBerger from "./__golden__/buchholz-sonneborn-berger.json";
import buchholzBye from "./__golden__/buchholz-bye.json";
import drawingLots from "./__golden__/drawing-lots.json";
// ---- end blog batch 2 ----
// ---- batch 3 (Swiss and seeding) ----
import knockoutSeeds from "./__golden__/knockout-seeds.json";
import swissBye from "./__golden__/swiss-bye.json";
import swissByeRounds from "./__golden__/swiss-bye-rounds.json";
import swissLateAndWithdraw from "./__golden__/swiss-late-and-withdraw.json";
import swissPairing from "./__golden__/swiss-pairing.json";
// ---- end batch 3 ----
import type { ExampleResult } from "./types";
// --- blog batch 4 (knockouts) ---
import thirdPlaceMatch from "./__golden__/third-place-match.json";
import knockoutMatchEndsLevel from "./__golden__/knockout-match-ends-level.json";
import pagePlayoffAndStepladder from "./__golden__/page-playoff-and-stepladder.json";
import doubleEliminationExplained from "./__golden__/double-elimination-explained.json";
import whatIsAPlate from "./__golden__/what-is-a-plate.json";
const BATCH_4: Record<string, ExampleResult> = {
  "third-place-match": thirdPlaceMatch as ExampleResult,
  "knockout-match-ends-level": knockoutMatchEndsLevel as ExampleResult,
  "page-playoff-and-stepladder": pagePlayoffAndStepladder as ExampleResult,
  "double-elimination-explained": doubleEliminationExplained as ExampleResult,
  "what-is-a-plate": whatIsAPlate as ExampleResult,
};
// --- end blog batch 4 ---

export const BLOG_GOLDENS: Record<string, ExampleResult> = {
  "chess-points": chessPoints as ExampleResult,
  "cricket-points": cricketPoints as ExampleResult,
  "matches-won-first": matchesWonFirst as ExampleResult,
  "shootout-points": shootoutPoints as ExampleResult,
  "standings-points": standingsPoints as ExampleResult,
  "table-tennis-loss": tableTennisLoss as ExampleResult,
  ...BATCH_4,
  // ---- batch 5 (Task 11) ----
  "ladder-challenge": ladderChallenge as ExampleResult,
  "knockout-withdrawal": knockoutWithdrawal as ExampleResult,
  "forfeit-scores": forfeitScores as ExampleResult,
  "double-walkover": doubleWalkover as ExampleResult,
  // ---- end batch 5 ----
  // ---- blog batch 2 ----
  "level-on-points": levelOnPoints as ExampleResult,
  "three-way-tie": threeWayTie as ExampleResult,
  "net-run-rate": netRunRate as ExampleResult,
  "set-ratio-or-difference": setRatioOrDifference as ExampleResult,
  "buchholz-sonneborn-berger": buchholzSonnebornBerger as ExampleResult,
  "buchholz-bye": buchholzBye as ExampleResult,
  "drawing-lots": drawingLots as ExampleResult,
  // ---- end blog batch 2 ----
  // ---- batch 3 (Swiss and seeding) ----
  "swiss-pairing": swissPairing as ExampleResult,
  "swiss-bye": swissBye as ExampleResult,
  "swiss-bye-rounds": swissByeRounds as ExampleResult,
  "swiss-late-and-withdraw": swissLateAndWithdraw as ExampleResult,
  "knockout-seeds": knockoutSeeds as ExampleResult,
  // ---- end batch 3 ----
};
