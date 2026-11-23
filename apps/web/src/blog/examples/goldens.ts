// What a post renders from: each example's committed golden, imported statically so the build needs no engine run
// and no file read at request time (the standalone build ships no src/). A new example adds its line here;
// blog-examples.test.ts fails on a golden file with no line, and on a line with no registered example.
import standingsPoints from "./__golden__/standings-points.json";
// ---- batch 5 (Task 11) ----
import americanoRotation from "./__golden__/americano-rotation.json";
import mexicanoNextRound from "./__golden__/mexicano-next-round.json";
import ladderChallenge from "./__golden__/ladder-challenge.json";
import knockoutWithdrawal from "./__golden__/knockout-withdrawal.json";
import forfeitScores from "./__golden__/forfeit-scores.json";
import doubleWalkover from "./__golden__/double-walkover.json";
// ---- end batch 5 ----
import type { ExampleResult } from "./types";

export const BLOG_GOLDENS: Record<string, ExampleResult> = {
  "standings-points": standingsPoints as ExampleResult,
  // ---- batch 5 (Task 11) ----
  "americano-rotation": americanoRotation as ExampleResult,
  "mexicano-next-round": mexicanoNextRound as ExampleResult,
  "ladder-challenge": ladderChallenge as ExampleResult,
  "knockout-withdrawal": knockoutWithdrawal as ExampleResult,
  "forfeit-scores": forfeitScores as ExampleResult,
  "double-walkover": doubleWalkover as ExampleResult,
  // ---- end batch 5 ----
};
