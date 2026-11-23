// What a post renders from: each example's committed golden, imported statically so the build needs no engine run
// and no file read at request time (the standalone build ships no src/). A new example adds its line here;
// blog-examples.test.ts fails on a golden file with no line, and on a line with no registered example.
import standingsPoints from "./__golden__/standings-points.json";
// ---- batch 5 (Task 11) ----
import ladderChallenge from "./__golden__/ladder-challenge.json";
import knockoutWithdrawal from "./__golden__/knockout-withdrawal.json";
import forfeitScores from "./__golden__/forfeit-scores.json";
import doubleWalkover from "./__golden__/double-walkover.json";
// ---- end batch 5 ----
import type { ExampleResult } from "./types";

export const BLOG_GOLDENS: Record<string, ExampleResult> = {
  "standings-points": standingsPoints as ExampleResult,
  // ---- batch 5 (Task 11) ----
  "ladder-challenge": ladderChallenge as ExampleResult,
  "knockout-withdrawal": knockoutWithdrawal as unknown as ExampleResult,
  "forfeit-scores": forfeitScores as ExampleResult,
  "double-walkover": doubleWalkover as unknown as ExampleResult,
  // ---- end batch 5 ----
};
