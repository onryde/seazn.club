// What a post renders from: each example's committed golden, imported statically so the build needs no engine run
// and no file read at request time (the standalone build ships no src/). A new example adds its line here;
// blog-examples.test.ts fails on a golden file with no line, and on a line with no registered example.
import chessPoints from "./__golden__/chess-points.json";
import cricketPoints from "./__golden__/cricket-points.json";
import matchesWonFirst from "./__golden__/matches-won-first.json";
import shootoutPoints from "./__golden__/shootout-points.json";
import standingsPoints from "./__golden__/standings-points.json";
import tableTennisLoss from "./__golden__/table-tennis-loss.json";
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
};
