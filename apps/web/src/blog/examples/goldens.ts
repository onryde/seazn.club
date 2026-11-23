// What a post renders from: each example's committed golden, imported statically so the build needs no engine run
// and no file read at request time (the standalone build ships no src/). A new example adds its line here;
// blog-examples.test.ts fails on a golden file with no line, and on a line with no registered example.
import standingsPoints from "./__golden__/standings-points.json";
// ---- batch 3 (Swiss and seeding) ----
import swissBye from "./__golden__/swiss-bye.json";
import swissByeRounds from "./__golden__/swiss-bye-rounds.json";
import swissLateAndWithdraw from "./__golden__/swiss-late-and-withdraw.json";
import swissPairing from "./__golden__/swiss-pairing.json";
// ---- end batch 3 ----
import type { ExampleResult } from "./types";

export const BLOG_GOLDENS: Record<string, ExampleResult> = {
  "standings-points": standingsPoints as ExampleResult,
  // ---- batch 3 (Swiss and seeding) ----
  "swiss-pairing": swissPairing as ExampleResult,
  "swiss-bye": swissBye as ExampleResult,
  "swiss-bye-rounds": swissByeRounds as ExampleResult,
  "swiss-late-and-withdraw": swissLateAndWithdraw as ExampleResult,
  // ---- end batch 3 ----
};
