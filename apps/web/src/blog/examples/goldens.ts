// What a post renders from: each example's committed golden, imported statically so the build needs no engine run
// and no file read at request time (the standalone build ships no src/). A new example adds its line here;
// blog-examples.test.ts fails on a golden file with no line, and on a line with no registered example.
import standingsPoints from "./__golden__/standings-points.json";
import type { ExampleResult } from "./types";
// --- blog batch 4 (knockouts) ---
import thirdPlaceMatch from "./__golden__/third-place-match.json";
import knockoutMatchEndsLevel from "./__golden__/knockout-match-ends-level.json";
const BATCH_4: Record<string, ExampleResult> = {
  "third-place-match": thirdPlaceMatch as ExampleResult,
  "knockout-match-ends-level": knockoutMatchEndsLevel as ExampleResult,
};
// --- end blog batch 4 ---

export const BLOG_GOLDENS: Record<string, ExampleResult> = {
  "standings-points": standingsPoints as ExampleResult,
  ...BATCH_4,
};
